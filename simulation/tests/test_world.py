import datetime as dt
import random

from simulation import behavior, demand, world
from simulation.topology import equipment, graph, staff, zones

WEEKDAY_10AM = dt.datetime(2026, 8, 12, 10, 0, tzinfo=demand.KST)


def _fresh_world(seed: int = 1) -> world.World:
    return world.World(rng=random.Random(seed), now=1000.0)


class TestInitialState:
    def test_tracks_every_tag(self):
        assert len(_fresh_world().tags) == 50

    def test_everything_starts_available_at_its_home_zone(self):
        instance = _fresh_world()
        for item in equipment.EQUIPMENT:
            assert instance.state_of(item.tag_id) is behavior.AssetState.AVAILABLE
            assert instance.zone_of(item.tag_id) == item.home_zone

    def test_has_a_window_for_every_simulated_reader(self):
        instance = _fresh_world()
        assert set(instance.windows) == zones.SIM_ZONE_IDS

    def test_never_creates_a_window_for_a_real_hardware_reader(self):
        assert not (set(_fresh_world().windows) & zones.REAL_READER_IDS)


class TestPhysics:
    def test_feeds_samples_to_nearby_readers_only(self):
        instance = _fresh_world()
        instance.tick_physics(1000.2, world.PHYSICS_TICK_SEC)
        payloads = {p["reader_id"]: p for p in instance.collect_payloads(1000.3)}
        heard = {p["reader_id"] for p in payloads.values() if p["observations"]}
        assert heard  # 뭔가는 들려야 한다
        assert len(heard) < len(zones.SIM_ZONE_IDS)  # 전부 다 들리면 모델이 틀렸다

    def test_a_resting_tag_is_heard_strongest_by_its_own_reader(self):
        instance = _fresh_world()
        item = next(i for i in equipment.EQUIPMENT if i.profile.slug == "hd")
        for step in range(15):
            instance.tick_physics(1000.0 + step * 0.2, world.PHYSICS_TICK_SEC)
        best = {}
        for payload in instance.collect_payloads(1003.0):
            for observation in payload["observations"]:
                if observation["tag_id"] == item.tag_id:
                    best[payload["reader_id"]] = observation["rssi"]
        assert max(best, key=best.get) == item.home_zone

    def test_each_tag_is_heard_by_a_handful_of_readers(self):
        instance = _fresh_world()
        for step in range(15):
            instance.tick_physics(1000.0 + step * 0.2, world.PHYSICS_TICK_SEC)
        per_tag = {}
        for payload in instance.collect_payloads(1003.0):
            for observation in payload["observations"]:
                per_tag.setdefault(observation["tag_id"], set()).add(payload["reader_id"])
        for tag_id, readers in per_tag.items():
            assert 1 <= len(readers) <= 8, (tag_id, readers)

    def test_every_reader_emits_a_payload_even_with_nothing_to_report(self):
        instance = _fresh_world()
        payloads = instance.collect_payloads(1000.0)
        assert len(payloads) == len(zones.SIM_ZONE_IDS)


class TestCheckoutLifecycle:
    def test_issues_checkout_commands_for_available_equipment(self):
        instance = _fresh_world(seed=3)
        commands = []
        for step in range(50):
            commands += instance.tick_behavior(WEEKDAY_10AM, 1000.0 + step * world.BEHAVIOR_TICK_SEC)
        assert commands
        for command in commands:
            assert command.nfc_token == equipment.EQUIPMENT_BY_TAG[command.tag_id].nfc_token
            assert command.username

    def test_a_pending_tag_is_not_offered_again(self):
        instance = _fresh_world(seed=3)
        first = instance.tick_behavior(WEEKDAY_10AM, 1000.0)
        while not first:
            first = instance.tick_behavior(WEEKDAY_10AM, 1010.0)
        pending = {c.tag_id for c in first}
        again = {c.tag_id for c in instance.tick_behavior(WEEKDAY_10AM, 1020.0)}
        assert not (pending & again)

    def test_a_rejected_checkout_returns_the_tag_to_available(self):
        instance = _fresh_world(seed=3)
        command = _first_checkout(instance)
        instance.reject_checkout(command.tag_id, 1100.0)
        assert instance.state_of(command.tag_id) is behavior.AssetState.AVAILABLE

    def test_a_confirmed_checkout_starts_the_journey(self):
        instance = _fresh_world(seed=3)
        command = _first_checkout(instance)
        instance.confirm_checkout(command.tag_id, 1100.0)
        assert instance.state_of(command.tag_id) in (
            behavior.AssetState.TRANSIT,
            behavior.AssetState.IN_USE,
            behavior.AssetState.RETURNING,
        )

    def test_concurrent_count_reflects_confirmed_checkouts(self):
        instance = _fresh_world(seed=3)
        assert instance.concurrent_checkouts == 0
        command = _first_checkout(instance)
        instance.confirm_checkout(command.tag_id, 1100.0)
        assert instance.concurrent_checkouts == 1

    def test_concurrent_count_ignores_band_exempt_types(self):
        instance = _fresh_world(seed=3)
        command = _first_checkout(instance, exempt=True)
        instance.confirm_checkout(command.tag_id, 1100.0)
        assert instance.state_of(command.tag_id) is not behavior.AssetState.AVAILABLE
        assert instance.concurrent_checkouts == 0


class TestChronicShortage:
    def test_exempt_types_stay_mostly_checked_out_on_a_weekday(self, monkeypatch):
        # RSSI 생성은 대여 상태와 무관하고 느리므로 끈다
        monkeypatch.setattr(world.World, "_broadcast", lambda *args, **kwargs: None)
        start = WEEKDAY_10AM.replace(hour=6)
        instance = world.World(rng=random.Random(5), now=0.0)
        busy: dict[str, list[float]] = {slug: [] for slug in demand.BAND_EXEMPT_SLUGS}
        physics_sec = 1.0
        now = 0.0
        while now < 12 * 3600:
            instance.tick_physics(now, physics_sec)
            if now % world.BEHAVIOR_TICK_SEC == 0:
                moment = start + dt.timedelta(seconds=now)
                for command in instance.tick_behavior(moment, now):
                    instance.confirm_checkout(command.tag_id, now)
                for command in instance.due_returns(moment, now):
                    instance.confirm_return(command.tag_id, now)
                if 10 <= moment.hour < 17 and now % 600 == 0:
                    for slug in busy:
                        tags = [t for t in instance.tags.values() if t.item.profile.slug == slug]
                        in_use = sum(t.state is not behavior.AssetState.AVAILABLE for t in tags)
                        busy[slug].append(in_use / len(tags))
            now += physics_sec
        for slug, samples in busy.items():
            assert sum(samples) / len(samples) >= 0.8, slug


class TestMovementIntegration:
    def test_a_tag_only_ever_moves_between_adjacent_zones(self):
        instance = _fresh_world(seed=4)
        command = _first_checkout(instance)
        instance.confirm_checkout(command.tag_id, 1100.0)
        previous = instance.zone_of(command.tag_id)
        now = 1100.0
        # dt를 1초로 키운다 — 최대 1.6m라 가장 짧은 구간(5m 이상)도 건너뛰지 않으면서
        # 50개 태그 x 42개 리더를 20만 번 도는 낭비를 피한다.
        for _ in range(4_000):
            now += 1.0
            instance.tick_physics(now, 1.0)
            current = instance.zone_of(command.tag_id)
            if current != previous:
                assert current in graph.NEIGHBORS[previous], f"{previous} -> {current}"
                previous = current

    def test_a_tag_never_leaves_its_floor(self):
        # 정지 상태만 보면 층간 엣지가 없다는 이유로 항상 통과하는 공허한 테스트가 된다.
        # 실제로 대여해 움직이는 장비를 섞어야 이동 경로가 층을 넘지 않는 걸 검증한다.
        instance = _fresh_world(seed=5)
        command = _first_checkout(instance)
        instance.confirm_checkout(command.tag_id, 1100.0)
        item = equipment.EQUIPMENT_BY_TAG[command.tag_id]
        start_zone = instance.zone_of(command.tag_id)
        moved = False
        now = 1100.0
        for _ in range(2_000):
            now += 1.0
            instance.tick_physics(now, 1.0)
            if instance.zone_of(command.tag_id) != start_zone:
                moved = True
            assert zones.ZONE_BY_ID[instance.zone_of(command.tag_id)].floor == item.floor
        assert moved, "대여한 장비가 움직이지 않았다"


class TestReturnLifecycle:
    def test_every_checkout_eventually_produces_a_return(self):
        instance = _fresh_world(seed=6)
        command = _first_checkout(instance)
        instance.confirm_checkout(command.tag_id, 1100.0)
        now = 1100.0
        # 30초 스텝으로 약 42시간을 돌린다. 가장 긴 사용(혈액투석기 4시간 x 예외 4배)도
        # 반드시 그 안에 끝나야 한다.
        for _ in range(5_000):
            now += 30.0
            instance.tick_physics(now, 30.0)
            instance.tick_behavior(WEEKDAY_10AM, now)
            due = instance.due_returns(WEEKDAY_10AM, now)
            if any(r.tag_id == command.tag_id for r in due):
                return
        raise AssertionError("반납 명령이 나오지 않았다 — 상태 머신이 막혔다")

    def test_a_confirmed_return_makes_the_tag_available_again(self):
        instance = _fresh_world(seed=6)
        command = _first_checkout(instance)
        instance.confirm_checkout(command.tag_id, 1100.0)
        instance.confirm_return(command.tag_id, 1200.0)
        assert instance.state_of(command.tag_id) is behavior.AssetState.AVAILABLE
        assert instance.concurrent_checkouts == 0

    def test_a_failed_return_is_retried_later(self):
        instance = _fresh_world(seed=6)
        command = _first_checkout(instance)
        instance.confirm_checkout(command.tag_id, 1100.0)
        # 반납 지점에 도착해 명령이 나간 뒤 실패한 상황을 재현한다 — 이동 중에는
        # due_returns가 애초에 명령을 내지 않으므로 retry_return이 불릴 일이 없다.
        tag = instance.tags[command.tag_id]
        tag.state = behavior.AssetState.RETURNING
        tag.journey = None
        tag.pending = True
        instance.retry_return(command.tag_id, 1200.0)
        assert instance.state_of(command.tag_id) is behavior.AssetState.RETURNING
        assert not any(r.tag_id == command.tag_id for r in instance.due_returns(WEEKDAY_10AM, 1205.0))
        assert any(r.tag_id == command.tag_id for r in instance.due_returns(WEEKDAY_10AM, 1300.0))

    def test_the_returner_is_usually_the_borrower(self):
        instance = _fresh_world(seed=8)
        command = _first_checkout(instance)
        borrower = command.username
        instance.confirm_checkout(command.tag_id, 1100.0)
        tag = instance.tags[command.tag_id]
        tag.state = behavior.AssetState.RETURNING
        tag.journey = None
        tag.return_ready_at = 1100.0
        same = 0
        for _ in range(200):
            returns = instance.due_returns(WEEKDAY_10AM, 1200.0)
            same += sum(1 for r in returns if r.username == borrower)
            instance.retry_return(command.tag_id, 1100.0)
        assert same > 150

    def test_available_equipment_does_not_move(self):
        instance = _fresh_world(seed=7)
        item = equipment.EQUIPMENT[0]
        start = instance.zone_of(item.tag_id)
        now = 1000.0
        for _ in range(500):
            now += 1.0
            instance.tick_physics(now, 1.0)
        assert instance.zone_of(item.tag_id) == start


class TestAdoptCheckedOut:
    def test_a_tag_with_no_assignment_becomes_returning_without_crashing(self):
        """재시작 시나리오: 방금 태어난 태그에 assignment가 아직 없다."""
        instance = _fresh_world(seed=9)
        item = equipment.EQUIPMENT[0]
        instance.adopt_checked_out(item.tag_id, 1000.0)
        assert instance.state_of(item.tag_id) is behavior.AssetState.RETURNING

    def test_produces_a_due_return_with_a_valid_username(self):
        instance = _fresh_world(seed=9)
        item = equipment.EQUIPMENT[0]
        instance.adopt_checked_out(item.tag_id, 1000.0)
        due = instance.due_returns(WEEKDAY_10AM, 1000.0)
        command = next((r for r in due if r.tag_id == item.tag_id), None)
        assert command is not None
        assert command.username in staff.STAFF_BY_USERNAME

    def test_a_tag_with_an_existing_assignment_keeps_its_borrower(self):
        """월드-DB 어긋남 시나리오: 이미 이동 중이던 태그를 반납 대상으로 흡수한다."""
        instance = _fresh_world(seed=9)
        command = _first_checkout(instance)
        instance.confirm_checkout(command.tag_id, 1100.0)
        tag = instance.tags[command.tag_id]
        original_borrower = tag.assignment.borrower
        instance.adopt_checked_out(command.tag_id, 1200.0)
        assert tag.assignment.borrower == original_borrower
        assert instance.state_of(command.tag_id) is behavior.AssetState.RETURNING
        assert not instance.tags[command.tag_id].pending


def _first_checkout(instance: world.World, *, exempt: bool = False) -> world.CheckoutCommand:
    """동시 대여 보정 제외 여부가 exempt와 같은 첫 대여 명령."""
    now = 1000.0
    for _ in range(2000):
        now += world.BEHAVIOR_TICK_SEC
        for command in instance.tick_behavior(WEEKDAY_10AM, now):
            slug = equipment.EQUIPMENT_BY_TAG[command.tag_id].profile.slug
            if (slug in demand.BAND_EXEMPT_SLUGS) == exempt:
                return command
    raise AssertionError("대여 명령이 나오지 않았다")
