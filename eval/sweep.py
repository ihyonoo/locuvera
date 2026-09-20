"""격자 탐색 — 같은 트레이스에 파라미터만 바꿔 판정을 다시 돌리고 지표를 모은다.

조합마다 시뮬레이터를 다시 돌리면 난수가 새로 뽑혀 이동 경로와 신호 표본이 달라지므로,
관측된 차이가 파라미터 때문인지 운 때문인지 구분되지 않는다. 트레이스를 재사용하면
모든 조합이 완전히 동일한 입력을 받는다.

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
from eval.positioning import replay_transitions

HYST_DB_GRID = (0, 2, 4, 6, 8, 10, 12)
DWELL_SEC_GRID = (0, 1, 2, 3, 5)
STALE_SEC_GRID = (0, 1, 2, 3, 5, 8, 10)

FIELDS = (
    "hyst_db",
    "dwell_sec",
    "stale_sec",
    "rest_accuracy",
    "false_switch_per_hour",
    "unheard_ratio",
    "delay_p50",
    "delay_p95",
    "missed_transitions",
    "path_recall",
    "path_precision",
    "rest_samples",
    "move_samples",
    "true_transitions",
    "judged_transitions",
)


@dataclass(frozen=True)
class Row:
    hyst_db: int
    dwell_sec: int
    stale_sec: int
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


def decision_grid() -> list[DecisionParams]:
    return [
        DecisionParams(hyst_db=hyst, dwell_sec=dwell, stale_sec=stale)
        for hyst in HYST_DB_GRID
        for dwell in DWELL_SEC_GRID
        for stale in STALE_SEC_GRID
    ]


_TRACE_PATH: Path | None = None
_TRUTH: list[metrics.TruthSample] | None = None
_HEARD: set[tuple[str, int]] | None = None


def _init_worker(trace_path: str) -> None:
    """워커마다 한 번만 참값을 읽어 둔다. 관측은 조합마다 스트리밍한다."""
    global _TRACE_PATH, _TRUTH, _HEARD
    _TRACE_PATH = Path(trace_path)
    connection = trace.open_trace(_TRACE_PATH)
    _TRUTH = list(trace.read_truth(connection))
    _HEARD = trace.read_heard(connection)
    connection.close()


def _run_one(params: DecisionParams) -> Row:
    connection = trace.open_trace(_TRACE_PATH)
    transitions = replay_transitions(trace.read_observations(connection), params)
    connection.close()

    result = metrics.compute(_TRUTH, transitions, heard=_HEARD)
    return Row(
        hyst_db=params.hyst_db,
        dwell_sec=params.dwell_sec,
        stale_sec=params.stale_sec,
        **asdict(result),
    )


def run(trace_path: Path, out_csv: Path, *, workers: int | None = None) -> list[Row]:
    grid = decision_grid()
    workers = workers or max(1, (os.cpu_count() or 2) - 1)

    with Pool(workers, initializer=_init_worker, initargs=(str(trace_path),)) as pool:
        rows = pool.map(_run_one, grid)

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))
    return rows
