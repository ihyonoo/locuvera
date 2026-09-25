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
from eval import dataset, metrics, trace
from eval.aggregate import reaggregate
from eval.positioning import replay_dataset
from simulation.reader import AGGREGATORS

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


def _init_worker(trace_path: str) -> None:
    global _TRACE_PATH
    _TRACE_PATH = Path(trace_path)


def _dataset_for(aggregation: Aggregation) -> dataset.Dataset:
    """해당 집계 설정으로 관측을 다시 만들고 압축본으로 담는다."""
    window_sec, send_every_sec, aggregate = aggregation
    connection = trace.open_trace(_TRACE_PATH)
    try:
        return dataset.build(
            (
                (o.recv_ts, o.reader_id, o.tag_id, o.rssi)
                for o in reaggregate(
                    trace.read_raw_samples(connection),
                    window_sec=window_sec,
                    send_every_sec=send_every_sec,
                    aggregate=aggregate,
                )
            ),
            lambda horizon: connection.execute(
                "SELECT ts, tag_id, zone_a, zone_b FROM truth WHERE ts <= ? ORDER BY tag_id, ts", (horizon,)
            ),
        )
    finally:
        connection.close()


def _run_aggregation(aggregation: Aggregation) -> list[Row]:
    """집계 설정 하나를 고정하고 판정 격자 전체를 돌린다."""
    data = _dataset_for(aggregation)
    if not data.observation_count:
        return []
    return [
        _row(params, aggregation, metrics.compute_dataset(data, replay_dataset(data, params)))
        for params in decision_grid()
    ]


def _write(out_csv: Path, rows: list[Row]) -> None:
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def _workers(requested: int | None) -> int:
    return requested or max(1, (os.cpu_count() or 2) - 1)


def run(trace_path: Path, out_csv: Path, *, workers: int | None = None, progress=None) -> list[Row]:
    """집계 격자와 판정 격자를 완전 교차한다.

    두 축은 서로 간섭한다 — 리더가 앞에서 잡음을 많이 걸러 보내면 서버 쪽 억제는 느슨해도
    되고, 날것에 가깝게 보내면 빡빡해야 한다. 한쪽을 고정하고 고른 최적이 다른 쪽에서도
    최적이라는 보장이 없으므로 전부 교차한다.

    작업 단위는 집계 설정 하나다. 재집계 결과를 압축본으로 한 번 만들어 두고 그 위에서
    판정 격자를 돌리므로, 재집계가 조합마다 반복되지 않는다.
    """
    grid = aggregation_grid()
    rows: list[Row] = []
    with Pool(_workers(workers), initializer=_init_worker, initargs=(str(trace_path),)) as pool:
        for done, batch in enumerate(pool.imap_unordered(_run_aggregation, grid), start=1):
            rows.extend(batch)
            if progress:
                progress(done, len(grid), len(rows))

    rows.sort(key=lambda r: (r.window_sec, r.send_every_sec, r.aggregate, r.hyst_db, r.dwell_sec, r.stale_sec))
    _write(out_csv, rows)
    return rows
