"""압축 표현이 원본과 같은 판정을 내는지 확인한다.

스윕은 메모리 때문에 압축 배열 위에서 돌지만, 논문이 평가하는 것은 어디까지나
백엔드의 판정 규칙이다. 두 경로가 갈라지면 결과 전체가 근거를 잃는다.
"""

import datetime as dt
import tempfile
from pathlib import Path

import pytest

from backend.location_decision import DecisionParams
from eval import dataset, trace
from eval.collect import collect
from eval.positioning import replay_dataset, replay_transitions
from simulation import demand

PARAMS = [
    DecisionParams(),
    DecisionParams(hyst_db=0, dwell_sec=0, stale_sec=0),
    DecisionParams(hyst_db=12, dwell_sec=5, stale_sec=10),
    DecisionParams(decay_db_per_sec=4.0),
]


@pytest.fixture(scope="module")
def trace_path():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "trace.sqlite"
        collect(
            path,
            hours=0.05,
            raw_hours=0.0,
            seed=3,
            start=dt.datetime(2026, 9, 21, 9, 0, tzinfo=demand.KST),
        )
        yield path


class TestCompactReplay:
    @pytest.mark.parametrize("params", PARAMS)
    def test_it_matches_the_reference_replay(self, trace_path, params):
        connection = trace.open_trace(trace_path)
        expected = replay_transitions(trace.read_observations(connection), params)
        connection.close()

        data = dataset.load(trace_path)
        actual = [
            (data.tags.names[tag], data.zones.names[zone], decided_at)
            for tag, zone, decided_at in replay_dataset(data, params)
        ]

        assert actual == expected


class TestDatasetShape:
    def test_it_keeps_every_row(self, trace_path):
        connection = trace.open_trace(trace_path)
        observations = sum(1 for _ in trace.read_observations(connection))
        truth = sum(1 for _ in trace.read_truth(connection))
        connection.close()

        data = dataset.load(trace_path)

        assert data.observation_count == observations
        assert data.truth_count == truth

    def test_the_heard_bitmap_matches_the_observation_seconds(self, trace_path):
        connection = trace.open_trace(trace_path)
        heard = trace.read_heard(connection)
        connection.close()

        data = dataset.load(trace_path)

        for tag_id, ts in heard:
            entry = data.truth[data.tags.names.index(tag_id)]
            assert entry.was_heard(ts), (tag_id, ts)


class TestCompactMetrics:
    @pytest.mark.parametrize("params", PARAMS)
    def test_metrics_match_between_the_two_paths(self, trace_path, params):
        from eval import metrics

        connection = trace.open_trace(trace_path)
        reference = metrics.compute(
            trace.read_truth(connection),
            replay_transitions(trace.read_observations(connection), params),
            heard=trace.read_heard(connection),
        )
        connection.close()

        data = dataset.load(trace_path)
        compact = metrics.compute_dataset(data, replay_dataset(data, params))

        assert compact == reference
