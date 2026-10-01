import pytest

from eval.rtls_live_bench import (
    assert_bench_urls,
    container_env,
    container_urls,
    growth_plan,
    percentile,
    polling_offsets,
    summarize,
)


class TestPercentile:
    def test_interpolates_between_ranks(self):
        assert percentile([10, 20, 30, 40], 50) == 25

    def test_extremes_are_min_and_max(self):
        values = [5, 1, 9, 3]
        assert percentile(values, 0) == 1
        assert percentile(values, 100) == 9

    def test_single_value(self):
        assert percentile([7], 95) == 7


class TestSummarize:
    def test_reports_p50_p95_max_mean(self):
        stats = summarize([float(v) for v in range(1, 101)])
        assert stats == {"p50": 50.5, "p95": pytest.approx(95.05), "max": 100.0, "mean": 50.5}

    def test_empty_sample_gives_none(self):
        # 전부 타임아웃된 셀도 행으로 남아야 한다.
        assert summarize([]) == {"p50": None, "p95": None, "max": None, "mean": None}


class TestGrowthPlan:
    def test_each_step_inserts_only_the_difference(self):
        assert growth_plan([10_000, 100_000, 1_000_000]) == [
            (0, 10_000),
            (10_000, 100_000),
            (100_000, 1_000_000),
        ]

    def test_sizes_are_sorted(self):
        assert growth_plan([100, 10]) == [(0, 10), (10, 100)]

    def test_rejects_duplicates(self):
        with pytest.raises(ValueError):
            growth_plan([10, 10])


class TestPollingOffsets:
    def test_clients_are_spread_evenly_over_one_period(self):
        assert polling_offsets(4) == [0.0, 0.25, 0.5, 0.75]

    def test_single_client_starts_immediately(self):
        assert polling_offsets(1) == [0.0]


class TestBenchUrlGuard:
    def test_accepts_bench_db_and_redis_2(self):
        assert_bench_urls(
            "postgresql://mediledger:pw@localhost:5432/mediledger_bench_db",
            "redis://127.0.0.1:6379/2",
        )

    @pytest.mark.parametrize(
        ("db_url", "redis_url"),
        [
            ("postgresql://mediledger:pw@localhost:5432/mediledger_db", "redis://127.0.0.1:6379/2"),
            ("postgresql://mediledger:pw@localhost:5432/mediledger_bench_db", "redis://127.0.0.1:6379/0"),
            ("postgresql://mediledger:pw@localhost:5432/mediledger_bench_db", "redis://127.0.0.1:6379"),
        ],
    )
    def test_refuses_anything_else(self, db_url, redis_url):
        with pytest.raises(SystemExit):
            assert_bench_urls(db_url, redis_url)


class TestContainerUrls:
    def test_points_at_compose_service_names_and_keeps_credentials(self):
        assert container_urls(
            "postgresql://mediledger:pw@localhost:5432/mediledger_bench_db",
            "redis://127.0.0.1:6379/2",
        ) == (
            "postgresql://mediledger:pw@postgres:5432/mediledger_bench_db",
            "redis://redis:6379/2",
        )


class TestContainerEnv:
    def _env(self, flags):
        return dict(flag.split("=", 1) for flag in flags[1::2])

    def test_redis_on_points_at_bench_redis(self):
        env = self._env(
            container_env("postgresql://u:p@localhost:5432/mediledger_bench_db", "redis://127.0.0.1:6379/2", redis=True)
        )
        assert env["REDIS_URL"] == "redis://redis:6379/2"

    def test_redis_off_points_at_a_port_that_refuses_immediately(self):
        # 연결 대기 시간이 측정에 섞이지 않도록 타임아웃이 아니라 즉시 거부되는 주소를 쓴다.
        env = self._env(
            container_env(
                "postgresql://u:p@localhost:5432/mediledger_bench_db", "redis://127.0.0.1:6379/2", redis=False
            )
        )
        assert env["REDIS_URL"] == "redis://127.0.0.1:1/2"
        assert env["DATABASE_URL"] == "postgresql://u:p@postgres:5432/mediledger_bench_db"
