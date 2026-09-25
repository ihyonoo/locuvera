"""판정 시퀀스를 참값과 대조해 측위 품질 지표를 낸다.

정지 구간과 이동 구간을 나눠서 잰다. 이동 중인 장비는 두 구역 중심 사이를 지나가므로
어느 쪽을 정답이라 하기 어렵고, 억제 파라미터가 두 구간에 정반대로 작용하기 때문이다.
구역마다 리더가 한 대이므로 판정된 reader_id를 그대로 구역으로 본다.
"""

from bisect import bisect_right
from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import NamedTuple

# 참값 전환 이후 이만큼 지나도 따라오지 않으면 놓친 전환으로 센다.
DELAY_HORIZON_SEC = 120


class TruthSample(NamedTuple):
    ts: int
    tag_id: str
    zone_a: str
    zone_b: str
    progress: float

    @property
    def resting(self) -> bool:
        return self.zone_a == self.zone_b


@dataclass(frozen=True)
class Metrics:
    rest_accuracy: float | None
    false_switch_per_hour: float | None
    unheard_ratio: float | None
    delay_p50: float | None
    delay_p95: float | None
    missed_transitions: int
    path_recall: float | None
    path_precision: float | None
    rest_samples: int
    move_samples: int
    true_transitions: int
    judged_transitions: int


def _percentile(values: list[float], fraction: float) -> float | None:
    """선형 보간 없이 가장 가까운 순위값을 쓴다 — 표본이 적을 때 있지도 않은 값이 나오지 않게."""
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1))))
    return ordered[index]


def _ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


class JudgedTrack:
    """한 태그의 판정 이력. 전환 시각만 들고 있다가 임의 시각의 판정 구역을 돌려준다."""

    def __init__(self, transitions: list[tuple[int, str]]) -> None:
        self.times = [ts for ts, _ in transitions]
        self.zones = [zone for _, zone in transitions]

    def zone_at(self, ts: int) -> str | None:
        position = bisect_right(self.times, ts)
        return self.zones[position - 1] if position else None

    def first_arrival(self, zone: str, not_before: int) -> int | None:
        """해당 시각 이후 처음으로 그 구역으로 전환한 시각."""
        for ts, judged_zone in zip(self.times, self.zones, strict=True):
            if ts >= not_before and judged_zone == zone:
                return ts
        return None


def _group_transitions(transitions: Iterable[tuple[str, str, int]]) -> dict[str, list[tuple[int, str]]]:
    grouped: dict[str, list[tuple[int, str]]] = {}
    for tag_id, reader_id, decided_at in transitions:
        grouped.setdefault(tag_id, []).append((decided_at, reader_id))
    for rows in grouped.values():
        # 같은 초에 전환이 여러 번 일어나면 나중 것이 그 시각의 판정이다. 시각만으로
        # 안정 정렬해 실제 순서를 지킨다 — 튜플째 정렬하면 구역 이름순으로 뒤바뀐다.
        rows.sort(key=lambda row: row[0])
    return grouped


def _true_transitions(samples: list[TruthSample]) -> list[tuple[int, str]]:
    """참값 구역이 실제로 바뀐 시각. 이동 중 표본은 출발 구역을 기준으로 본다."""
    changes: list[tuple[int, str]] = []
    previous: str | None = None
    for sample in samples:
        if sample.zone_a != previous:
            if previous is not None:
                changes.append((sample.ts, sample.zone_a))
            previous = sample.zone_a
    return changes


def _zone_at(ts_seq, zone_seq, ts: int):
    """해당 시각 이하의 가장 최근 참값 구역."""
    position = bisect_right(ts_seq, ts)
    return zone_seq[position - 1] if position else None


def _accumulate(entries) -> Metrics:
    """태그별 (참값 시각, 출발 구역, 목적 구역, 청취 판정, 판정 이력)으로 지표를 낸다.

    구역을 문자열로 주든 정수 인덱스로 주든 비교만 하므로 결과는 같다.
    """
    rest_total = rest_hit = move_total = unheard = 0
    delays: list[float] = []
    missed = 0
    true_transition_count = judged_transition_count = 0
    recalls: list[float] = []
    precisions: list[float] = []
    false_switches = 0
    span_seconds = 0
    tag_count = 0

    for ts_seq, zone_a_seq, zone_b_seq, was_heard, track in entries:
        tag_count += 1
        if not len(ts_seq):
            continue
        span_seconds = max(span_seconds, ts_seq[-1] - ts_seq[0])

        previous_zone = None
        changes: list[tuple[int, object]] = []
        for position in range(len(ts_seq)):
            ts = ts_seq[position]
            zone_a = zone_a_seq[position]

            if was_heard is not None and not was_heard(ts):
                unheard += 1

            if zone_a == zone_b_seq[position]:
                rest_total += 1
                if track.zone_at(ts) == zone_a:
                    rest_hit += 1
            else:
                move_total += 1

            if zone_a != previous_zone:
                if previous_zone is not None:
                    changes.append((ts, zone_a))
                previous_zone = zone_a

        # 참값이 바뀐 시각마다, 판정이 같은 구역으로 따라오기까지 걸린 시간.
        true_transition_count += len(changes)
        for changed_at, zone in changes:
            arrival = track.first_arrival(zone, changed_at)
            if arrival is None or arrival - changed_at > DELAY_HORIZON_SEC:
                missed += 1
            else:
                delays.append(arrival - changed_at)

        # 참값이 그대로인데 판정만 바뀐 전환은 오전환이다.
        previous_truth = None
        for ts in track.times:
            judged_transition_count += 1
            current_truth = _zone_at(ts_seq, zone_a_seq, ts)
            if previous_truth is not None and current_truth == previous_truth:
                false_switches += 1
            previous_truth = current_truth

        truth_zones = set(zone_a_seq) | set(zone_b_seq)
        judged_zones = set(track.zones)
        if truth_zones:
            recalls.append(len(truth_zones & judged_zones) / len(truth_zones))
        if judged_zones:
            precisions.append(len(truth_zones & judged_zones) / len(judged_zones))

    hours = (span_seconds * tag_count) / 3600 if tag_count else 0
    return Metrics(
        rest_accuracy=_ratio(rest_hit, rest_total),
        false_switch_per_hour=false_switches / hours if hours else None,
        unheard_ratio=_ratio(unheard, rest_total + move_total) if unheard or rest_total else None,
        delay_p50=_percentile(delays, 0.5),
        delay_p95=_percentile(delays, 0.95),
        missed_transitions=missed,
        path_recall=sum(recalls) / len(recalls) if recalls else None,
        path_precision=sum(precisions) / len(precisions) if precisions else None,
        rest_samples=rest_total,
        move_samples=move_total,
        true_transitions=true_transition_count,
        judged_transitions=judged_transition_count,
    )


def compute(
    truth: Iterable[TruthSample],
    transitions: Iterable[tuple[str, str, int]],
    heard: set[tuple[str, int]] | None = None,
) -> Metrics:
    """참값 표본과 판정 전환으로 지표를 낸다.

    heard는 (tag_id, ts) 가운데 어떤 리더든 그 태그를 들은 것들이다. 주면 미청취 비율을 낸다.
    """
    by_tag: dict[str, list[TruthSample]] = {}
    for sample in truth:
        by_tag.setdefault(sample.tag_id, []).append(sample)
    for samples in by_tag.values():
        samples.sort()

    judged = {tag_id: JudgedTrack(rows) for tag_id, rows in _group_transitions(transitions).items()}
    empty = JudgedTrack([])

    def entries():
        for tag_id, samples in by_tag.items():
            listener = None if heard is None else (lambda ts, tag_id=tag_id: (tag_id, ts) in heard)
            yield (
                [sample.ts for sample in samples],
                [sample.zone_a for sample in samples],
                [sample.zone_b for sample in samples],
                listener,
                judged.get(tag_id, empty),
            )

    result = _accumulate(entries())
    if heard is None:
        result = replace(result, unheard_ratio=None)
    return result


def compute_dataset(data, transitions: Iterable[tuple[int, int, int]]) -> Metrics:
    """압축 배열 위에서 같은 지표를 낸다. 구역과 태그는 정수 인덱스로 비교한다."""
    grouped: dict[int, list[tuple[int, int]]] = {}
    for tag, zone, decided_at in transitions:
        grouped.setdefault(tag, []).append((decided_at, zone))
    for rows in grouped.values():
        rows.sort(key=lambda row: row[0])

    empty = JudgedTrack([])

    def entries():
        for index, entry in enumerate(data.truth):
            yield (
                entry.ts,
                entry.zone_a,
                entry.zone_b,
                entry.was_heard,
                JudgedTrack(grouped[index]) if index in grouped else empty,
            )

    return _accumulate(entries())
