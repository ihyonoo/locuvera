"""격자 탐색 — 같은 트레이스에 파라미터만 바꿔 판정을 다시 돌리고 지표를 모은다.

조합마다 시뮬레이터를 다시 돌리면 난수가 새로 뽑혀 이동 경로와 신호 표본이 달라지므로,
관측된 차이가 파라미터 때문인지 운 때문인지 구분되지 않는다. 트레이스를 재사용하면
모든 조합이 완전히 동일한 입력을 받는다.

탐색은 두 단계다. 판정 축은 기록된 관측을 다시 해석하기만 하면 되므로 전탐색하고,
집계 축은 관측 자체를 다시 만들어야 해서 1단계에서 고른 상위 조합에만 교차한다.
전부 곱하면 조합이 2만을 넘고 대부분은 볼 가치가 없는 구석이다.

조합끼리는 서로 의존하지 않으므로 프로세스로 나눠 돌린다. 워커마다 트레이스를
직접 열어 스트리밍하므로, 수천만 행을 프로세스 수만큼 복제해 들고 있지 않는다.
"""

import csv
import os
from dataclasses import asdict, dataclass
from multiprocessing import Pool
from pathlib import Path

from backend.location_decision import DecisionParams
from eval import metrics, trace
from eval.aggregate import reaggregate
from eval.positioning import Observation, replay_transitions
from simulation.reader import AGGREGATORS, DEFAULT_AGGREGATE, SEND_EVERY_SEC, WINDOW_SEC

HYST_DB_GRID = (0, 2, 4, 6, 8, 10, 12)
DWELL_SEC_GRID = (0, 1, 2, 3, 5)
STALE_SEC_GRID = (0, 1, 2, 3, 5, 8, 10)
DECAY_DB_PER_SEC_GRID = (0.0, 2.0, 4.0)

WINDOW_SEC_GRID = (1.0, 2.0, 3.0, 5.0)
SEND_EVERY_SEC_GRID = (0.5, 1.0, 2.0)
AGGREGATE_GRID = tuple(AGGREGATORS)


@dataclass(frozen=True)
class Row:
    hyst_db: int
    dwell_sec: int
    stale_sec: int
    decay_db_per_sec: float
    window_sec: float
    send_every_sec: float
    aggregate: str
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


FIELDS = tuple(Row.__dataclass_fields__)


class Aggregation(tuple):
    """(window_sec, send_every_sec, aggregate)."""


def decision_grid() -> list[DecisionParams]:
    return [
        DecisionParams(hyst_db=hyst, dwell_sec=dwell, stale_sec=stale, decay_db_per_sec=decay)
        for hyst in HYST_DB_GRID
        for dwell in DWELL_SEC_GRID
        for stale in STALE_SEC_GRID
        for decay in DECAY_DB_PER_SEC_GRID
    ]


def aggregation_grid() -> list[Aggregation]:
    return [
        Aggregation((window, send, aggregate))
        for window in WINDOW_SEC_GRID
        for send in SEND_EVERY_SEC_GRID
        for aggregate in AGGREGATE_GRID
    ]


def _row(params: DecisionParams, aggregation: Aggregation, result: metrics.Metrics) -> Row:
    window_sec, send_every_sec, aggregate = aggregation
    return Row(
        hyst_db=params.hyst_db,
        dwell_sec=params.dwell_sec,
        stale_sec=params.stale_sec,
        decay_db_per_sec=params.decay_db_per_sec,
        window_sec=window_sec,
        send_every_sec=send_every_sec,
        aggregate=aggregate,
        **asdict(result),
    )


_TRACE_PATH: Path | None = None
_TRUTH: list[metrics.TruthSample] | None = None
_HEARD: set[tuple[str, int]] | None = None
_DECISIONS: list[DecisionParams] | None = None

CURRENT_AGGREGATION = Aggregation((WINDOW_SEC, SEND_EVERY_SEC, DEFAULT_AGGREGATE))


def _init_worker(trace_path: str, decisions: list[DecisionParams] | None = None) -> None:
    """워커마다 한 번만 참값을 읽어 둔다. 관측은 조합마다 스트리밍한다."""
    global _TRACE_PATH, _TRUTH, _HEARD, _DECISIONS
    _TRACE_PATH = Path(trace_path)
    _DECISIONS = decisions
    connection = trace.open_trace(_TRACE_PATH)
    _TRUTH = list(trace.read_truth(connection))
    _HEARD = trace.read_heard(connection)
    connection.close()


def _run_decision(params: DecisionParams) -> Row:
    connection = trace.open_trace(_TRACE_PATH)
    transitions = replay_transitions(trace.read_observations(connection), params)
    connection.close()

    result = metrics.compute(_TRUTH, transitions, heard=_HEARD)
    return _row(params, CURRENT_AGGREGATION, result)


def _run_aggregation(aggregation: Aggregation) -> list[Row]:
    window_sec, send_every_sec, aggregate = aggregation
    connection = trace.open_trace(_TRACE_PATH)
    observations: list[Observation] = list(
        reaggregate(
            trace.read_raw_samples(connection),
            window_sec=window_sec,
            send_every_sec=send_every_sec,
            aggregate=aggregate,
        )
    )
    connection.close()

    if not observations:
        return []

    # 원시 표본은 트레이스의 앞부분 구간만 남기므로, 참값도 같은 구간으로 자른다.
    horizon = max(observation.recv_ts for observation in observations)
    truth = [sample for sample in _TRUTH if sample.ts <= horizon]
    heard = {(observation.tag_id, observation.recv_ts) for observation in observations}

    rows = []
    for params in _DECISIONS:
        transitions = replay_transitions(observations, params)
        rows.append(_row(params, aggregation, metrics.compute(truth, transitions, heard=heard)))
    return rows


def _write(out_csv: Path, rows: list[Row]) -> None:
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def _workers(requested: int | None) -> int:
    return requested or max(1, (os.cpu_count() or 2) - 1)


def run_decisions(trace_path: Path, out_csv: Path, *, workers: int | None = None) -> list[Row]:
    """1단계 — 집계는 현행에 고정하고 판정 축을 전탐색한다."""
    with Pool(_workers(workers), initializer=_init_worker, initargs=(str(trace_path),)) as pool:
        rows = pool.map(_run_decision, decision_grid())
    _write(out_csv, rows)
    return rows


def run_aggregations(
    trace_path: Path,
    out_csv: Path,
    decisions: list[DecisionParams],
    *,
    workers: int | None = None,
) -> list[Row]:
    """2단계 — 1단계에서 고른 판정 조합만 들고 집계 축을 교차한다."""
    with Pool(_workers(workers), initializer=_init_worker, initargs=(str(trace_path), decisions)) as pool:
        batches = pool.map(_run_aggregation, aggregation_grid())
    rows = [row for batch in batches for row in batch]
    _write(out_csv, rows)
    return rows


def top_decisions(rows: list[Row], count: int) -> list[DecisionParams]:
    """정지 정확도가 높은 순으로 판정 조합을 고른다."""
    ranked = sorted(
        (row for row in rows if row.rest_accuracy is not None),
        key=lambda row: row.rest_accuracy,
        reverse=True,
    )
    return [
        DecisionParams(
            hyst_db=row.hyst_db,
            dwell_sec=row.dwell_sec,
            stale_sec=row.stale_sec,
            decay_db_per_sec=row.decay_db_per_sec,
        )
        for row in ranked[:count]
    ]
