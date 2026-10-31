"""장비 가동률 분석 — 대여 구간을 시간 칸으로 나눠 가동률·판정·히트맵을 만든다."""

import datetime as dt
from collections import defaultdict
from dataclasses import dataclass

import psycopg

try:
    from backend.settings import DATABASE_URL
except ModuleNotFoundError as exc:
    if not exc.name or not exc.name.startswith("backend"):
        raise
    from settings import DATABASE_URL

# KST는 일광 절약 시간이 없어 고정 오프셋으로 충분하다 (simulation/demand.py와 같다)
KST = dt.timezone(dt.timedelta(hours=9))

SHORTAGE_THRESHOLD = 0.8
IDLE_THRESHOLD = 0.2
ESSENTIAL_TYPES = frozenset({"제세동기", "응급카트"})
UNCLASSIFIED_TYPE = "미분류"
PERIOD_DAYS = (7, 30, 90)

HOUR = dt.timedelta(hours=1)
# datetime.weekday() 기준: 월=0 … 일=6
WEEKDAYS = range(0, 5)
WEEKEND = range(5, 7)


@dataclass(frozen=True)
class Unit:
    tag_id: str
    equipment_name: str
    equipment_type: str | None


@dataclass(frozen=True)
class Interval:
    tag_id: str
    checkout_at: dt.datetime
    returned_at: dt.datetime | None


def floor_to_hour(moment: dt.datetime) -> dt.datetime:
    return moment.astimezone(KST).replace(minute=0, second=0, microsecond=0)


def resolve_start(requested_start: dt.datetime, earliest_checkout: dt.datetime | None) -> dt.datetime:
    # 이력이 기간보다 짧으면 첫 이력부터 센다 — 빈 기간이 분모를 부풀리지 않게
    if earliest_checkout is None:
        return requested_start
    return max(requested_start, floor_to_hour(earliest_checkout))


def load_utilization_inputs(
    start: dt.datetime, end: dt.datetime
) -> tuple[list[Unit], list[Interval], dt.datetime | None]:
    """활성 장비, 기간과 겹치는 대여 구간, 전체 이력의 첫 대여 시각을 읽는다."""
    with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT tag_id, equipment_name, equipment_type
            FROM tags
            WHERE is_active = TRUE AND asset_status <> 'inactive'
            """
        )
        units = [Unit(*row) for row in cur.fetchall()]
        cur.execute(
            """
            SELECT u.tag_id, u.checkout_at, u.returned_at
            FROM usage_history u
            JOIN tags t ON t.tag_id = u.tag_id
            WHERE t.is_active = TRUE AND t.asset_status <> 'inactive'
              AND u.checkout_at < %s
              AND (u.returned_at IS NULL OR u.returned_at > %s)
            """,
            (end, start),
        )
        intervals = [Interval(*row) for row in cur.fetchall()]
        cur.execute("SELECT MIN(checkout_at) FROM usage_history")
        earliest = cur.fetchone()[0]
    return units, intervals, earliest


def _ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0


def _type_name(equipment_type: str | None) -> str:
    return (equipment_type or "").strip() or UNCLASSIFIED_TYPE


def _hour_cells(start: dt.datetime, end: dt.datetime):
    """[start, end)를 정시 경계로 잘라 (요일, 시, 초) 조각을 낸다."""
    cursor = start.astimezone(KST)
    end = end.astimezone(KST)
    while cursor < end:
        slot_end = floor_to_hour(cursor) + HOUR
        piece_end = min(end, slot_end)
        yield cursor.weekday(), cursor.hour, (piece_end - cursor).total_seconds()
        cursor = piece_end


def _empty_grid() -> list[list[float]]:
    return [[0] * 24 for _ in range(7)]


def _verdict(type_name: str, peak: float) -> str:
    if peak >= SHORTAGE_THRESHOLD:
        return "shortage"
    if type_name in ESSENTIAL_TYPES:
        return "essential"
    if peak < IDLE_THRESHOLD:
        return "idle"
    return "adequate"


def _additional_units(peak: float, unit_count: int) -> int:
    # 피크 때 쓰이던 대수가 (보유 + n)대의 SHORTAGE_THRESHOLD 미만이 되는 최소 n
    in_use = peak * unit_count
    extra = 1
    while in_use / (unit_count + extra) >= SHORTAGE_THRESHOLD:
        extra += 1
    return extra


def compute_utilization(units: list[Unit], intervals: list[Interval], start: dt.datetime, end: dt.datetime) -> dict:
    period_seconds = max((end - start).total_seconds(), 0)

    # 기간 안에 각 (요일, 시) 칸이 나타난 횟수
    occurrences = _empty_grid()
    for weekday, hour, _ in _hour_cells(start, end):
        occurrences[weekday][hour] += 1

    tags = {u.tag_id: u for u in units}
    busy_by_tag: dict[str, float] = defaultdict(float)
    count_by_tag: dict[str, int] = defaultdict(int)
    cells_by_type: dict[str, list[list[float]]] = defaultdict(_empty_grid)
    for interval in intervals:
        if interval.tag_id not in tags:
            continue
        # 겹침 조건은 조회 SQL과 같다: checkout_at < end AND (returned_at IS NULL OR returned_at > start)
        if interval.checkout_at >= end or (interval.returned_at is not None and interval.returned_at <= start):
            continue
        returned_at = interval.returned_at or end
        count_by_tag[interval.tag_id] += 1
        cells = cells_by_type[_type_name(tags[interval.tag_id].equipment_type)]
        for weekday, hour, seconds in _hour_cells(max(interval.checkout_at, start), min(returned_at, end)):
            busy_by_tag[interval.tag_id] += seconds
            cells[weekday][hour] += seconds

    units_by_type: dict[str, list[Unit]] = defaultdict(list)
    for u in units:
        units_by_type[_type_name(u.equipment_type)].append(u)

    def to_heatmap(cells: list[list[float]], unit_count: int) -> list[list[float]]:
        return [[_ratio(cells[d][h], unit_count * occurrences[d][h] * 3600) for h in range(24)] for d in range(7)]

    def to_hourly(cells: list[list[float]], unit_count: int) -> dict[str, list[float]]:
        def group(days: range) -> list[float]:
            return [
                _ratio(sum(cells[d][h] for d in days), unit_count * sum(occurrences[d][h] for d in days) * 3600)
                for h in range(24)
            ]

        return {"weekday": group(WEEKDAYS), "weekend": group(WEEKEND)}

    types = []
    by_type_heatmap = {}
    by_type_hourly = {}
    all_cells = _empty_grid()
    for type_name, members in units_by_type.items():
        unit_count = len(members)
        cells = cells_by_type[type_name]
        for d in range(7):
            for h in range(24):
                all_cells[d][h] += cells[d][h]

        hourly = [
            _ratio(sum(cells[d][h] for d in range(7)), unit_count * sum(occurrences[d][h] for d in range(7)) * 3600)
            for h in range(24)
        ]
        peak = max(hourly)
        busy_total = sum(busy_by_tag[u.tag_id] for u in members)
        verdict = _verdict(type_name, peak)

        type_units = [
            {
                "tag_id": u.tag_id,
                "equipment_name": u.equipment_name,
                "utilization": _ratio(busy_by_tag[u.tag_id], period_seconds),
                "checkout_count": count_by_tag[u.tag_id],
            }
            for u in members
        ]
        type_units.sort(key=lambda item: (-item["utilization"], item["equipment_name"]))

        types.append(
            {
                "equipment_type": type_name,
                "unit_count": unit_count,
                "utilization": _ratio(busy_total, unit_count * period_seconds),
                "peak_hour": hourly.index(peak) if busy_total > 0 else None,
                "peak_utilization": peak,
                "checkout_count": sum(count_by_tag[u.tag_id] for u in members),
                "verdict": verdict,
                "additional_units": _additional_units(peak, unit_count) if verdict == "shortage" else None,
                "units": type_units,
            }
        )
        by_type_heatmap[type_name] = to_heatmap(cells, unit_count)
        by_type_hourly[type_name] = to_hourly(cells, unit_count)

    types.sort(key=lambda item: (-item["peak_utilization"], item["equipment_type"]))

    return {
        "summary": {
            "utilization": _ratio(sum(busy_by_tag.values()), len(units) * period_seconds),
            "shortage_type_count": sum(1 for item in types if item["verdict"] == "shortage"),
            "idle_type_count": sum(1 for item in types if item["verdict"] == "idle"),
        },
        "types": types,
        "heatmap": {"all": to_heatmap(all_cells, len(units)), "by_type": by_type_heatmap},
        "hourly": {"all": to_hourly(all_cells, len(units)), "by_type": by_type_hourly},
    }
