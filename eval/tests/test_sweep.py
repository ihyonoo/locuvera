"""완전 교차 스윕이 기존 경로와 같은 값을 내는지 확인한다.

집계 설정을 현행으로 고정한 행은 트레이스에 기록된 관측을 그대로 쓴 결과와 같아야 한다.
재집계가 원본을 되살리므로, 여기서 어긋나면 교차 결과 전체를 믿을 수 없다.
"""

import datetime as dt
import tempfile
from pathlib import Path

import pytest

from backend.location_decision import DecisionParams
from eval import dataset, metrics, sweep
from eval.collect import collect
from eval.positioning import replay_dataset
from simulation import demand
from simulation.reader import DEFAULT_AGGREGATE, SEND_EVERY_SEC, WINDOW_SEC


@pytest.fixture(scope="module")
def trace_path():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "trace.sqlite"
        collect(
            path,
            hours=0.03,
            raw_hours=0.03,
            seed=5,
            start=dt.datetime(2026, 9, 21, 9, 0, tzinfo=demand.KST),
        )
        yield path


class TestFullCross:
    def test_the_grid_is_every_aggregation_times_every_decision(self):
        assert len(sweep.aggregation_grid()) == 4 * 3 * 4
        assert len(sweep.decision_grid()) == 7 * 5 * 7 * 3

    def test_the_current_aggregation_matches_the_recorded_observations(self, trace_path):
        params = DecisionParams()
        data = dataset.load(trace_path)
        expected = metrics.compute_dataset(data, replay_dataset(data, params))

        sweep._init_worker(str(trace_path))
        rebuilt = sweep._dataset_for(sweep.Aggregation((WINDOW_SEC, SEND_EVERY_SEC, DEFAULT_AGGREGATE)))
        actual = metrics.compute_dataset(rebuilt, replay_dataset(rebuilt, params))

        assert actual == expected

    def test_a_run_writes_one_row_per_combination(self, trace_path, tmp_path):
        out = tmp_path / "results.csv"
        grid = sweep.aggregation_grid()[:2]
        sweep._init_worker(str(trace_path))
        rows = [row for aggregation in grid for row in sweep._run_aggregation(aggregation)]
        sweep._write(out, rows)

        assert len(rows) == len(grid) * len(sweep.decision_grid())
        assert out.read_text(encoding="utf-8").count("\n") == len(rows) + 1
