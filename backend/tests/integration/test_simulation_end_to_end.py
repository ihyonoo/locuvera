"""시뮬레이터가 만든 페이로드를 실제 백엔드에 먹여 계약이 맞는지 확인한다.

simulation/tests가 아니라 여기 두는 이유: 테스트 DB와 Redis 논리 DB 격리를 해주는
backend/tests/conftest.py 픽스처가 필요하다. 격리 설정을 복제하면 개발용 Redis를
공유하는 사고가 재발한다.
"""

import datetime as dt
import random

import pytest

from backend.auth_utils import build_auth_token, pwd
from backend.tests.conftest import post_signed_ingest
from simulation import demand, world
from simulation.generate_seed import render_seed_sql
from simulation.topology import equipment, graph, zones

SIM_PASSWORD = "sim-test-password"
WEEKDAY_10AM = dt.datetime(2026, 8, 12, 10, 0, tzinfo=demand.KST)


@pytest.fixture
def seeded_hospital(db_conn):
    """시뮬레이션 토폴로지 전체를 테스트 DB에 넣는다."""
    with db_conn.cursor() as cur:
        cur.execute(render_seed_sql())
        cur.execute(
            "UPDATE users SET password_hash = %s WHERE is_real_hardware = FALSE",
            (pwd.hash(SIM_PASSWORD),),
        )
    db_conn.commit()
    return db_conn


def _headers_for(db_conn, username: str) -> dict:
    with db_conn.cursor() as cur:
        cur.execute("SELECT user_id FROM users WHERE username = %s", (username,))
        user_id = cur.fetchone()[0]
    token, _ = build_auth_token(user_id=user_id, token_version=0)
    return {"Authorization": f"Bearer {token}"}


def _any_staff_headers(db_conn) -> dict:
    """/where 같은 조회 엔드포인트는 인증이 필요하다. 아무 시뮬 staff 계정이나 쓴다."""
    with db_conn.cursor() as cur:
        cur.execute("SELECT username FROM users WHERE is_real_hardware = FALSE ORDER BY user_id LIMIT 1")
        username = cur.fetchone()[0]
    return _headers_for(db_conn, username)


def _pump_ingest(instance, client, monkeypatch, start: float, seconds: float, only_tag: str | None = None) -> float:
    """물리 틱을 돌리고 1초마다 /ingest를 보낸다. 서버 시각도 함께 진행시킨다.

    관측이 빈 하트비트 페이로드는 여기서 보내지 않는다 — 전용 테스트가 따로 검증하고,
    42개 리더분을 매초 밀어 넣으면 TestClient 왕복만으로 테스트가 몇 분씩 걸린다.
    only_tag를 주면 그 태그를 들은 리더만 보낸다 — 한 태그를 추적하는 테스트에서
    나머지 49개 태그분 왕복을 걷어낸다.
    """
    now = start
    steps = int(seconds / world.PHYSICS_TICK_SEC)
    for step in range(steps):
        now += world.PHYSICS_TICK_SEC
        instance.tick_physics(now, world.PHYSICS_TICK_SEC)
        if step % 5 != 4:
            continue
        monkeypatch.setattr("backend.server.time.time", lambda now=now: now)
        for payload in instance.collect_payloads(now):
            observations = payload["observations"]
            if only_tag is not None:
                observations = [o for o in observations if o["tag_id"] == only_tag]
            if observations:
                assert post_signed_ingest(client, {**payload, "observations": observations}).status_code == 200
    return now


class TestSeed:
    def test_seed_installs_the_expected_inventory(self, seeded_hospital):
        with seeded_hospital.cursor() as cur:
            cur.execute("SELECT count(*) FROM readers WHERE is_real_hardware = FALSE")
            assert cur.fetchone()[0] == 42
            cur.execute("SELECT count(*) FROM tags WHERE is_real_hardware = FALSE")
            assert cur.fetchone()[0] == 50
            cur.execute("SELECT count(*) FROM users WHERE is_real_hardware = FALSE")
            assert cur.fetchone()[0] == 120

    def test_every_reader_has_a_floor(self, seeded_hospital):
        # floor가 NULL이면 프론트 지도에서 그 구역이 통째로 사라진다.
        with seeded_hospital.cursor() as cur:
            cur.execute("SELECT count(*) FROM readers WHERE is_real_hardware = FALSE AND floor IS NULL")
            assert cur.fetchone()[0] == 0

    def test_ingest_does_not_create_a_reader_before_seed(self, client, db_conn):
        """등록 전 리더는 수신하지 않고, 재시드가 정본 등록값을 만든다."""
        reader_id = next(iter(zones.SIM_ZONE_IDS))
        response = client.post("/ingest", json={"reader_id": reader_id, "ts": 1000, "observations": []})
        assert response.status_code == 401

        with db_conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM readers WHERE reader_id = %s", (reader_id,))
            assert cur.fetchone()[0] == 0

        with db_conn.cursor() as cur:
            cur.execute(render_seed_sql())
        db_conn.commit()

        with db_conn.cursor() as cur:
            cur.execute("SELECT floor, is_real_hardware FROM readers WHERE reader_id = %s", (reader_id,))
            floor, is_real_hardware = cur.fetchone()
        assert floor is not None
        assert is_real_hardware is False


class TestIngestContract:
    def test_backend_accepts_every_payload_the_simulator_produces(self, client, seeded_hospital):
        instance = world.World(rng=random.Random(1), now=1000.0)
        instance.tick_physics(1000.2, world.PHYSICS_TICK_SEC)
        for payload in instance.collect_payloads(1000.3):
            assert post_signed_ingest(client, payload).status_code == 200

    def test_heartbeat_payloads_bring_every_reader_online(self, client, seeded_hospital):
        instance = world.World(rng=random.Random(1), now=1000.0)
        for payload in instance.collect_payloads(1000.0):
            assert post_signed_ingest(client, payload).status_code == 200
        with seeded_hospital.cursor() as cur:
            cur.execute("SELECT count(*) FROM readers WHERE is_real_hardware = FALSE AND last_seen_at IS NOT NULL")
            assert cur.fetchone()[0] == 42

    def test_resting_equipment_is_located_at_its_home_zone(self, client, seeded_hospital, monkeypatch):
        instance = world.World(rng=random.Random(2), now=1000.0)
        # 예열은 WINDOW_SEC(5초)만큼 창이 차고 DWELL_SEC(3초)만큼 체류가 확정될 시간을
        # 넘겨야 한다. 8초는 그 합과 같아 여유가 없으므로 두 배를 준다.
        _pump_ingest(instance, client, monkeypatch, start=1000.0, seconds=16.0)
        headers = _any_staff_headers(seeded_hospital)

        located = 0
        for item in equipment.EQUIPMENT:
            response = client.get(f"/where/{item.tag_id}", headers=headers)
            if response.status_code == 200 and response.json().get("reader_id") == item.home_zone:
                located += 1
        # 인접 리더가 더 세게 잡는 경계 사례가 있을 수 있으니 전부를 요구하지는 않는다.
        # 태그별 TX 편차가 tag_id로 시드되므로(radio.tag_tx_offset) tag_id를 바꾸면 경계
        # 사례가 재추첨된다 — 실측 범위가 43~50이라 임계값에 여유를 둔다.
        assert located >= 42


class TestPositionTracking:
    def test_location_only_ever_moves_to_an_adjacent_zone(self, client, seeded_hospital, monkeypatch):
        instance = world.World(rng=random.Random(3), now=1000.0)
        now = _pump_ingest(instance, client, monkeypatch, start=1000.0, seconds=8.0)

        # 실제 대여 경로를 그대로 탄다 — 시뮬레이터가 명령을 내고, API가 받고, 월드가 확정한다.
        command = _drive_first_checkout(instance, client, seeded_hospital, now)
        instance.confirm_checkout(command.tag_id, now)

        headers = _any_staff_headers(seeded_hospital)
        seen = [client.get(f"/where/{command.tag_id}", headers=headers).json().get("reader_id")]
        for _ in range(15):
            now = _pump_ingest(instance, client, monkeypatch, start=now, seconds=10.0, only_tag=command.tag_id)
            current = client.get(f"/where/{command.tag_id}", headers=headers).json().get("reader_id")
            if current and current != seen[-1]:
                assert current in graph.NEIGHBORS[seen[-1]], f"{seen[-1]} -> {current}"
                seen.append(current)
        assert len(seen) >= 2, "장비가 전혀 움직이지 않았다"

    def test_equipment_never_appears_on_another_floor(self, client, seeded_hospital, monkeypatch):
        instance = world.World(rng=random.Random(5), now=1000.0)
        now = _pump_ingest(instance, client, monkeypatch, start=1000.0, seconds=8.0)

        # 정지 상태만 보면 층간 엣지가 없다는 이유로 항상 통과하는 공허한 테스트가 된다.
        # 실제로 대여해 움직이는 장비를 섞어야 이동 경로가 층을 넘지 않는 걸 검증한다.
        command = _drive_first_checkout(instance, client, seeded_hospital, now)
        instance.confirm_checkout(command.tag_id, now)
        moved = equipment.EQUIPMENT_BY_TAG[command.tag_id]
        start_zone = instance.zone_of(command.tag_id)

        for _ in range(6):
            now = _pump_ingest(instance, client, monkeypatch, start=now, seconds=10.0, only_tag=command.tag_id)
        assert instance.zone_of(command.tag_id) != start_zone, "대여한 장비가 움직이지 않았다"

        headers = _any_staff_headers(seeded_hospital)
        for item in equipment.EQUIPMENT:
            reader_id = client.get(f"/where/{item.tag_id}", headers=headers).json().get("reader_id")
            if reader_id:
                assert zones.ZONE_BY_ID[reader_id].floor == item.floor, item.equipment_name
        assert zones.ZONE_BY_ID[instance.zone_of(command.tag_id)].floor == moved.floor


class TestUsageLifecycle:
    def test_checkout_and_return_produce_a_complete_history_row(self, client, seeded_hospital, monkeypatch):
        instance = world.World(rng=random.Random(6), now=1000.0)
        _pump_ingest(instance, client, monkeypatch, start=1000.0, seconds=8.0)

        item = next(i for i in equipment.EQUIPMENT if i.profile.slug == "pump")
        borrower = _any_nurse(item)
        headers = _headers_for(seeded_hospital, borrower.username)

        assert client.post("/usage/checkout", json={"nfc_token": item.nfc_token}, headers=headers).status_code == 200
        assert client.post("/usage/return", json={"nfc_token": item.nfc_token}, headers=headers).status_code == 200

        with seeded_hospital.cursor() as cur:
            cur.execute(
                "SELECT usage_status, checkout_location, return_location, returned_at "
                "FROM usage_history WHERE tag_id = %s",
                (item.tag_id,),
            )
            status, checkout_location, return_location, returned_at = cur.fetchone()
        assert status == "returned"
        assert returned_at is not None
        assert checkout_location == zones.ZONE_BY_ID[item.home_zone].name
        assert return_location is not None

    def test_a_different_staff_member_can_close_the_usage(self, client, seeded_hospital, monkeypatch):
        instance = world.World(rng=random.Random(7), now=1000.0)
        _pump_ingest(instance, client, monkeypatch, start=1000.0, seconds=8.0)

        item = next(i for i in equipment.EQUIPMENT if i.profile.slug == "pump")
        borrower = _any_nurse(item)
        returner = next(m for m in _on_duty_for(item) if m.username != borrower.username)

        client.post(
            "/usage/checkout",
            json={"nfc_token": item.nfc_token},
            headers=_headers_for(seeded_hospital, borrower.username),
        )
        response = client.post(
            "/usage/return",
            json={"nfc_token": item.nfc_token},
            headers=_headers_for(seeded_hospital, returner.username),
        )

        assert response.status_code == 200
        with seeded_hospital.cursor() as cur:
            cur.execute("SELECT user_name, returned_by_name FROM usage_history WHERE tag_id = %s", (item.tag_id,))
            user_name, returned_by_name = cur.fetchone()
        assert user_name == borrower.display_name
        assert returned_by_name == returner.display_name


def _drive_first_checkout(instance, client, db_conn, now: float):
    """월드가 첫 대여 명령을 낼 때까지 행동 틱을 돌리고, 그 명령을 실제 API로 실행한다."""
    for _ in range(5_000):
        now += world.BEHAVIOR_TICK_SEC
        for command in instance.tick_behavior(WEEKDAY_10AM, now):
            headers = _headers_for(db_conn, command.username)
            response = client.post("/usage/checkout", json={"nfc_token": command.nfc_token}, headers=headers)
            assert response.status_code == 200, response.text
            return command
    raise AssertionError("대여 명령이 나오지 않았다")


def _on_duty_for(item):
    from simulation import roster

    return [member for member, _ in roster.candidates_for(item, WEEKDAY_10AM)]


def _any_nurse(item):
    candidates = _on_duty_for(item)
    assert candidates, f"{item.equipment_name}를 쓸 수 있는 사람이 없다"
    return candidates[0]
