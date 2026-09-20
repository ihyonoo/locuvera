"""재집계가 수집 당시 리더가 실제로 보낸 관측을 그대로 되살리는지 확인한다.

기본 설정에서 원본과 어긋나면, 윈도우나 집계 방식을 바꿔 얻은 결과도 믿을 수 없다.
"""

import datetime as dt
import tempfile
from pathlib import Path

import pytest

from eval import trace
from eval.aggregate import reaggregate
from eval.collect import collect
from simulation import demand


@pytest.fixture(scope="module")
def raw_trace():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "trace.sqlite"
        collect(
            path,
            hours=0.02,
            raw_hours=0.02,
            seed=7,
            start=dt.datetime(2026, 9, 21, 9, 0, tzinfo=demand.KST),
        )
        connection = trace.open_trace(path)
        yield connection
        connection.close()


class TestReaggregation:
    def test_default_settings_reproduce_the_recorded_observations(self, raw_trace):
        recorded = list(trace.read_observations(raw_trace))
        rebuilt = list(reaggregate(trace.read_raw_samples(raw_trace)))

        assert recorded, "수집이 관측을 하나도 남기지 않았다"
        assert rebuilt == recorded

    def test_a_longer_window_keeps_more_samples_per_observation(self, raw_trace):
        short = list(reaggregate(trace.read_raw_samples(raw_trace), window_sec=1.0))
        long = list(reaggregate(trace.read_raw_samples(raw_trace), window_sec=4.0))

        assert sum(o.count for o in long) > sum(o.count for o in short)

    def test_max_never_reports_a_weaker_signal_than_min(self, raw_trace):
        strongest = list(reaggregate(trace.read_raw_samples(raw_trace), aggregate="max"))
        weakest = list(reaggregate(trace.read_raw_samples(raw_trace), aggregate="min"))

        assert len(strongest) == len(weakest)
        assert all(a.rssi >= b.rssi for a, b in zip(strongest, weakest, strict=True))

    def test_a_slower_send_period_produces_fewer_observations(self, raw_trace):
        often = list(reaggregate(trace.read_raw_samples(raw_trace), send_every_sec=1.0))
        rarely = list(reaggregate(trace.read_raw_samples(raw_trace), send_every_sec=2.0))

        assert len(rarely) < len(often)
