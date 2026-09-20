"""월드 상태 — 태그 50개의 위치·자산 상태를 들고 RSSI 샘플과 대여·반납 명령을 만든다.

HTTP를 모른다. 명령을 내면 simulator.py가 API를 호출하고 결과를 confirm/reject로
돌려준다. 덕분에 네트워크 없이도 상태 머신 전체를 테스트할 수 있다.
"""

import datetime as dt
import random
from dataclasses import dataclass, field

from simulation import behavior, demand, movement, radio, roster
from simulation.behavior import AssetState, Assignment
from simulation.reader import ReaderWindow
from simulation.topology import equipment, geometry, graph, staff, zones
from simulation.topology.equipment import Equipment
from simulation.topology.geometry import Point

PHYSICS_TICK_SEC = 0.2  # 태그 iBeacon 브로드캐스트 주기와 동일
BEHAVIOR_TICK_SEC = 10.0
RETURN_RETRY_SEC = 15.0


@dataclass(frozen=True)
class CheckoutCommand:
    tag_id: str
    nfc_token: str
    username: str


@dataclass(frozen=True)
class ReturnCommand:
    tag_id: str
    nfc_token: str
    username: str


@dataclass
class TagRuntime:
    item: Equipment
    state: AssetState
    zone: str
    point: Point
    journey: movement.Journey | None = None
    assignment: Assignment | None = None
    stop_index: int = 0
    dwell_until: float = 0.0
    pending: bool = False
    return_ready_at: float = 0.0
    tx_offset: float = 0.0
    slow: radio.SlowFading = field(default_factory=radio.SlowFading)


def _nearby_readers() -> dict[str, tuple[str, ...]]:
    """구역별로 신호가 닿을 수 있는 리더 목록. 매 틱 42개를 전부 도는 낭비를 막는다."""
    centers = {zone.reader_id: geometry.centroid(zone.polygon) for zone in zones.SIM_ZONES}
    table: dict[str, tuple[str, ...]] = {}
    for zone in zones.SIM_ZONES:
        candidates = [
            other.reader_id
            for other in zones.SIM_ZONES
            if other.floor == zone.floor
            and geometry.distance_m(centers[zone.reader_id], centers[other.reader_id]) <= radio.MAX_RANGE_M
        ]
        table[zone.reader_id] = tuple(candidates)
    return table


NEARBY_READERS: dict[str, tuple[str, ...]] = _nearby_readers()


class World:
    def __init__(self, rng: random.Random, now: float) -> None:
        self._rng = rng
        self.windows: dict[str, ReaderWindow] = {
            zone.reader_id: ReaderWindow(zone.reader_id) for zone in zones.SIM_ZONES
        }
        self.tags: dict[str, TagRuntime] = {}
        for item in equipment.EQUIPMENT:
            home = zones.ZONE_BY_ID[item.home_zone]
            self.tags[item.tag_id] = TagRuntime(
                item=item,
                state=AssetState.AVAILABLE,
                zone=item.home_zone,
                point=geometry.random_point_in(home.polygon, rng),
                tx_offset=radio.tag_tx_offset(item.tag_id),
            )
        self._planned: dict[str, Assignment] = {}
        self._surge = demand.NightSurge()
        self._last_behavior_at = now

    # --- 조회 -------------------------------------------------------------

    @property
    def concurrent_checkouts(self) -> int:
        return sum(1 for tag in self.tags.values() if tag.state is not AssetState.AVAILABLE and not tag.pending)

    def state_of(self, tag_id: str) -> AssetState:
        return self.tags[tag_id].state

    def zone_of(self, tag_id: str) -> str:
        return self.placement_of(tag_id).zone_a

    def placement_of(self, tag_id: str) -> movement.Placement:
        """참값 위치. 이동 중이면 출발·목적 구역과 진행률이 함께 들어 있다."""
        return self._placement(self.tags[tag_id])

    # --- 물리 -------------------------------------------------------------

    def _placement(self, tag: TagRuntime) -> movement.Placement:
        if tag.journey is None:
            return movement.resting_placement(tag.zone, tag.point)
        return movement.placement_of(tag.journey)

    def tick_physics(self, now: float, dt_sec: float) -> None:
        for tag in self.tags.values():
            if tag.journey is not None and movement.advance(tag.journey, dt_sec):
                self._arrive(tag, now)
            placement = self._placement(tag)
            self._broadcast(tag, placement, now, dt_sec)

    def _broadcast(self, tag: TagRuntime, placement: movement.Placement, now: float, dt_sec: float) -> None:
        for reader_id in NEARBY_READERS[placement.zone_a]:
            reader_center = geometry.centroid(zones.ZONE_BY_ID[reader_id].polygon)
            distance = geometry.distance_m(placement.point, reader_center)
            if distance > radio.MAX_RANGE_M:
                continue
            walls = movement.wall_hops(placement, reader_id)
            if walls >= graph.HOPS_UNREACHABLE:
                continue
            base = radio.path_loss_rssi(distance, walls)
            slow = tag.slow.value((tag.item.tag_id, reader_id), dt_sec, self._rng)
            rssi = radio.sample_rssi(base, tag.tx_offset, slow, self._rng)
            if self._rng.random() < radio.reception_probability(rssi):
                self.windows[reader_id].add(tag.item.tag_id, rssi, now)

    def _arrive(self, tag: TagRuntime, now: float) -> None:
        destination = tag.journey.path[-1]
        tag.journey = None
        tag.zone = destination
        tag.point = geometry.random_point_in(zones.ZONE_BY_ID[destination].polygon, self._rng)
        if tag.state is AssetState.TRANSIT:
            tag.state = AssetState.IN_USE
            tag.dwell_until = now + tag.assignment.dwell_sec[tag.stop_index]
        elif tag.state is AssetState.RETURNING:
            tag.return_ready_at = now

    def collect_payloads(self, now: float) -> list[dict]:
        return [window.build_payload(now) for window in self.windows.values()]

    # --- 행동 -------------------------------------------------------------

    def tick_behavior(self, moment: dt.datetime, now: float) -> list[CheckoutCommand]:
        # 절전 등으로 벽시계가 건너뛰면 interval이 치솟아 전 장비가 한 틱에 대여될 수 있다 — 상한을 둔다.
        interval = min(max(0.0, now - self._last_behavior_at), BEHAVIOR_TICK_SEC * 3)
        self._last_behavior_at = now
        self._advance_usage(now)
        return self._roll_checkouts(moment, now, interval or BEHAVIOR_TICK_SEC)

    def _advance_usage(self, now: float) -> None:
        for tag in self.tags.values():
            if tag.state is not AssetState.IN_USE or now < tag.dwell_until:
                continue
            assert tag.assignment is not None
            if tag.stop_index + 1 < len(tag.assignment.stops):
                tag.stop_index += 1
                self._depart(tag, tag.assignment.stops[tag.stop_index], AssetState.TRANSIT, now)
            else:
                self._depart(tag, tag.assignment.return_zone, AssetState.RETURNING, now)

    def _depart(self, tag: TagRuntime, destination: str, state: AssetState, now: float) -> None:
        tag.state = state
        journey = movement.plan_journey(tag.zone, destination, self._rng)
        if journey is None:
            # 같은 구역이면 이동 없이 곧바로 도착 처리한다.
            tag.journey = None
            self._arrive_in_place(tag, state, now)
            return
        tag.journey = journey

    def _arrive_in_place(self, tag: TagRuntime, state: AssetState, now: float) -> None:
        if state is AssetState.TRANSIT:
            tag.state = AssetState.IN_USE
            tag.dwell_until = now + tag.assignment.dwell_sec[tag.stop_index]
        else:
            tag.state = AssetState.RETURNING
            tag.return_ready_at = now

    def _roll_checkouts(self, moment: dt.datetime, now: float, interval: float) -> list[CheckoutCommand]:
        band = demand.target_band(moment)
        feedback = demand.feedback_factor(self.concurrent_checkouts, band)
        # 버스트 시작 판정은 틱당 한 번만 — 장비마다 굴리면 사실상 매 틱 터진다.
        self._surge.maybe_start(moment, now, interval, self._rng)
        commands: list[CheckoutCommand] = []
        for tag in self.tags.values():
            if tag.state is not AssetState.AVAILABLE or tag.pending:
                continue
            surge = self._surge.factor(tag.item.profile.demand_class, now)
            probability = min(1.0, demand.checkout_probability(tag.item.profile, moment, feedback, interval) * surge)
            if self._rng.random() >= probability:
                continue
            borrower = roster.pick_borrower(tag.item, moment, self._rng)
            if borrower is None:
                continue
            self._planned[tag.item.tag_id] = behavior.plan_assignment(tag.item, borrower, tag.zone, self._rng)
            tag.pending = True
            commands.append(CheckoutCommand(tag.item.tag_id, tag.item.nfc_token, borrower.username))
        return commands

    # --- 명령 결과 --------------------------------------------------------

    def confirm_checkout(self, tag_id: str, now: float) -> None:
        tag = self.tags[tag_id]
        tag.pending = False
        tag.assignment = self._planned.pop(tag_id)
        tag.stop_index = 0
        if tag.assignment.mistap:
            tag.state = AssetState.RETURNING
            tag.return_ready_at = now + tag.assignment.dwell_sec[0]
            return
        self._depart(tag, tag.assignment.stops[0], AssetState.TRANSIT, now)

    def reject_checkout(self, tag_id: str, now: float) -> None:
        del now
        tag = self.tags[tag_id]
        tag.pending = False
        tag.state = AssetState.AVAILABLE
        self._planned.pop(tag_id, None)

    def adopt_checked_out(self, tag_id: str, now: float) -> None:
        """백엔드에 우리가 모르는 열린 대여가 있을 때 그 태그를 반납 대상으로 흡수한다.

        시뮬레이터 재시작이나 재시드로 월드와 DB가 어긋나면 열린 usage_history 행이
        영영 닫히지 않는다 — 409를 만나면 되돌리지 말고 반납해서 정리한다.
        """
        tag = self.tags[tag_id]
        tag.pending = False
        self._planned.pop(tag_id, None)
        tag.journey = None
        tag.stop_index = 0
        if tag.assignment is None:
            moment = dt.datetime.fromtimestamp(now, tz=dt.UTC)
            borrower = roster.pick_borrower(tag.item, moment, self._rng) or staff.ROSTER[0]
            tag.assignment = Assignment(
                borrower=borrower, stops=(), dwell_sec=(0.0,), return_zone=tag.zone, mistap=False
            )
        tag.state = AssetState.RETURNING
        tag.return_ready_at = now

    def due_returns(self, moment: dt.datetime, now: float) -> list[ReturnCommand]:
        """반납자는 보통 대여자 본인이지만, 대여자가 퇴근했으면 거의 항상 동료가 대신한다."""
        due = []
        for tag in self.tags.values():
            if tag.state is not AssetState.RETURNING or tag.pending:
                continue
            if tag.journey is not None or now < tag.return_ready_at:
                continue
            tag.pending = True
            returner = roster.pick_returner(tag.item, tag.assignment.borrower, moment, self._rng)
            due.append(ReturnCommand(tag.item.tag_id, tag.item.nfc_token, returner.username))
        return due

    def confirm_return(self, tag_id: str, now: float) -> None:
        del now
        tag = self.tags[tag_id]
        tag.pending = False
        tag.state = AssetState.AVAILABLE
        tag.assignment = None
        tag.journey = None
        tag.stop_index = 0

    def retry_return(self, tag_id: str, now: float) -> None:
        """반납은 반드시 성공해야 한다 — 실패하면 잠시 뒤 다시 시도한다."""
        tag = self.tags[tag_id]
        tag.pending = False
        tag.state = AssetState.RETURNING
        tag.return_ready_at = now + RETURN_RETRY_SEC
