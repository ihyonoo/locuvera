import datetime as dt

import pytest

from backend.utilization import (
    KST,
    Interval,
    Unit,
    compute_utilization,
    floor_to_hour,
    resolve_start,
)

# 2026-10-05는 월요일이다.
DAY_START = dt.datetime(2026, 10, 5, tzinfo=KST)
DAY_END = DAY_START + dt.timedelta(days=1)


def at(hour, minute=0, day=5):
    return dt.datetime(2026, 10, day, hour, minute, tzinfo=KST)


def unit(tag_id, equipment_type="수액펌프", name=None):
    return Unit(tag_id=tag_id, equipment_name=name or tag_id, equipment_type=equipment_type)


def busy(tag_id, start, end):
    return Interval(tag_id=tag_id, checkout_at=start, returned_at=end)


def only_type(result):
    assert len(result["types"]) == 1
    return result["types"][0]


class TestFloorToHour:
    def test_drops_minutes_and_seconds_in_kst(self):
        moment = dt.datetime(2026, 10, 5, 0, 30, 15, tzinfo=dt.UTC)

        assert floor_to_hour(moment) == dt.datetime(2026, 10, 5, 9, tzinfo=KST)


class TestResolveStart:
    def test_keeps_requested_start_when_history_is_older(self):
        assert resolve_start(DAY_START, at(3, day=1)) == DAY_START

    def test_moves_start_to_first_checkout_hour_when_history_is_shorter(self):
        assert resolve_start(DAY_START, at(13, 40, day=6)) == at(13, day=6)

    def test_keeps_requested_start_without_history(self):
        assert resolve_start(DAY_START, None) == DAY_START


class TestUtilization:
    def test_clips_interval_to_period(self):
        result = compute_utilization([unit("a")], [busy("a", at(23, day=4), at(1))], DAY_START, DAY_END)

        assert only_type(result)["utilization"] == pytest.approx(1 / 24)

    def test_open_checkout_runs_to_period_end(self):
        result = compute_utilization([unit("a")], [busy("a", at(22), None)], DAY_START, DAY_END)

        assert only_type(result)["utilization"] == pytest.approx(2 / 24)

    def test_counts_checkouts_overlapping_period_including_zero_length(self):
        result = compute_utilization(
            [unit("a")],
            [busy("a", at(23, day=4), at(1)), busy("a", at(9), at(9))],
            DAY_START,
            DAY_END,
        )

        assert only_type(result)["checkout_count"] == 2
        assert only_type(result)["units"][0]["checkout_count"] == 2

    def test_ignores_intervals_of_inactive_tags(self):
        result = compute_utilization([unit("a")], [busy("gone", at(9), at(10))], DAY_START, DAY_END)

        assert only_type(result)["utilization"] == 0
        assert only_type(result)["checkout_count"] == 0

    def test_summary_weights_by_unit_count(self):
        units = [unit("a", "A"), unit("b1", "B"), unit("b2", "B"), unit("b3", "B")]
        result = compute_utilization(units, [busy("a", DAY_START, DAY_END)], DAY_START, DAY_END)

        assert result["summary"]["utilization"] == pytest.approx(0.25)


class TestHeatmap:
    def test_splits_interval_at_hour_boundaries(self):
        result = compute_utilization([unit("a")], [busy("a", at(9, 30), at(11, 15))], DAY_START, DAY_END)
        monday = result["heatmap"]["all"][0]

        assert monday[9] == pytest.approx(0.5)
        assert monday[10] == pytest.approx(1.0)
        assert monday[11] == pytest.approx(0.25)

    def test_uses_kst_weekday_and_hour(self):
        # UTC 일요일 15시 = KST 월요일 0시
        start = dt.datetime(2026, 10, 4, 15, tzinfo=dt.UTC)
        result = compute_utilization([unit("a")], [busy("a", start, start + dt.timedelta(hours=1))], DAY_START, DAY_END)

        assert result["heatmap"]["all"][0][0] == pytest.approx(1.0)
        assert result["heatmap"]["all"][6][15] == 0

    def test_cell_denominator_counts_occurrences_and_units(self):
        end = DAY_START + dt.timedelta(days=8)
        units = [unit("a"), unit("b")]
        intervals = [busy("a", at(10), at(11)), busy("a", at(10, day=12), at(11, day=12))]
        result = compute_utilization(units, intervals, DAY_START, end)

        # 월요일 10시는 기간 안에 두 번 나타나고 장비는 2대다
        assert result["heatmap"]["all"][0][10] == pytest.approx(2 / 4)
        assert result["heatmap"]["by_type"]["수액펌프"][0][10] == pytest.approx(2 / 4)

    def test_has_seven_weekdays_by_twenty_four_hours(self):
        result = compute_utilization([unit("a")], [], DAY_START, DAY_END)

        assert len(result["heatmap"]["all"]) == 7
        assert all(len(row) == 24 for row in result["heatmap"]["all"])


class TestHourlyProfile:
    def test_splits_weekday_and_weekend(self):
        end = DAY_START + dt.timedelta(days=7)
        intervals = [busy("a", at(10), at(11)), busy("a", at(10, day=10), at(11, day=10))]
        result = compute_utilization([unit("a")], intervals, DAY_START, end)
        hourly = result["hourly"]["all"]

        # 평일 10시는 5번(월~금), 주말 10시는 2번(토·일) 나타난다
        assert hourly["weekday"][10] == pytest.approx(1 / 5)
        assert hourly["weekend"][10] == pytest.approx(1 / 2)
        assert hourly["weekday"][11] == 0

    def test_denominator_counts_occurrences_and_units(self):
        end = DAY_START + dt.timedelta(days=8)
        intervals = [busy("a", at(10), at(11)), busy("a", at(10, day=12), at(11, day=12))]
        result = compute_utilization([unit("a"), unit("b")], intervals, DAY_START, end)

        # 평일 10시는 월요일 두 번을 포함해 6번, 장비는 2대다
        assert result["hourly"]["by_type"]["수액펌프"]["weekday"][10] == pytest.approx(2 / 12)

    def test_has_twenty_four_hours_per_group(self):
        hourly = compute_utilization([unit("a")], [], DAY_START, DAY_END)["hourly"]["all"]

        assert len(hourly["weekday"]) == 24
        assert len(hourly["weekend"]) == 24


class TestPeak:
    def test_hour_denominator_spans_all_days_in_period(self):
        end = DAY_START + dt.timedelta(days=2)
        result = compute_utilization([unit("a")], [busy("a", at(10), at(11))], DAY_START, end)
        item = only_type(result)

        assert item["peak_hour"] == 10
        assert item["peak_utilization"] == pytest.approx(0.5)

    def test_tie_picks_earlier_hour(self):
        intervals = [busy("a", at(14), at(15)), busy("a", at(9), at(10))]
        result = compute_utilization([unit("a")], intervals, DAY_START, DAY_END)

        assert only_type(result)["peak_hour"] == 9

    def test_no_usage_has_null_peak_hour(self):
        item = only_type(compute_utilization([unit("a")], [], DAY_START, DAY_END))

        assert item["peak_hour"] is None
        assert item["peak_utilization"] == 0


class TestVerdict:
    def test_shortage_at_threshold(self):
        units = [unit(f"p{i}") for i in range(5)]
        intervals = [busy(f"p{i}", at(10), at(11)) for i in range(4)]
        item = only_type(compute_utilization(units, intervals, DAY_START, DAY_END))

        assert item["peak_utilization"] == pytest.approx(0.8)
        assert item["verdict"] == "shortage"

    def test_adequate_just_below_shortage(self):
        interval = busy("a", at(10), at(10) + dt.timedelta(seconds=2844))
        item = only_type(compute_utilization([unit("a")], [interval], DAY_START, DAY_END))

        assert item["verdict"] == "adequate"

    @pytest.mark.parametrize(("unit_count", "busy_count", "expected"), [(5, 4, 1), (3, 3, 1), (10, 10, 3)])
    def test_additional_units_bring_peak_below_threshold(self, unit_count, busy_count, expected):
        units = [unit(f"p{i}") for i in range(unit_count)]
        intervals = [busy(f"p{i}", at(10), at(11)) for i in range(busy_count)]
        item = only_type(compute_utilization(units, intervals, DAY_START, DAY_END))

        assert item["additional_units"] == expected

    def test_essential_type_below_shortage_is_essential(self):
        item = only_type(compute_utilization([unit("d", "제세동기")], [], DAY_START, DAY_END))

        assert item["verdict"] == "essential"
        assert item["additional_units"] is None

    def test_essential_type_can_still_be_shortage(self):
        item = only_type(compute_utilization([unit("d", "응급카트")], [busy("d", at(10), at(11))], DAY_START, DAY_END))

        assert item["verdict"] == "shortage"

    def test_idle_below_idle_threshold(self):
        interval = busy("a", at(10), at(10) + dt.timedelta(seconds=684))
        item = only_type(compute_utilization([unit("a")], [interval], DAY_START, DAY_END))

        assert item["verdict"] == "idle"

    def test_adequate_at_idle_threshold(self):
        interval = busy("a", at(10), at(10, 12))
        item = only_type(compute_utilization([unit("a")], [interval], DAY_START, DAY_END))

        assert item["peak_utilization"] == pytest.approx(0.2)
        assert item["verdict"] == "adequate"
        assert item["additional_units"] is None

    def test_summary_counts_shortage_and_idle_types(self):
        units = [unit("a", "A"), unit("b", "B"), unit("d", "제세동기")]
        result = compute_utilization(units, [busy("a", at(10), at(11))], DAY_START, DAY_END)

        assert result["summary"]["shortage_type_count"] == 1
        assert result["summary"]["idle_type_count"] == 1


class TestGroupingAndOrder:
    @pytest.mark.parametrize("missing", [None, "", "   "])
    def test_missing_type_is_unclassified(self, missing):
        item = only_type(compute_utilization([unit("a", missing)], [], DAY_START, DAY_END))

        assert item["equipment_type"] == "미분류"

    def test_types_sorted_by_peak_desc_then_name(self):
        units = [unit("c", "다"), unit("b", "나"), unit("a", "가")]
        result = compute_utilization(units, [busy("c", at(10), at(11))], DAY_START, DAY_END)

        assert [item["equipment_type"] for item in result["types"]] == ["다", "가", "나"]

    def test_units_sorted_by_utilization_desc_then_name(self):
        units = [unit("t3", name="펌프-003"), unit("t1", name="펌프-001"), unit("t2", name="펌프-002")]
        result = compute_utilization(units, [busy("t3", at(10), at(11))], DAY_START, DAY_END)

        names = [u["equipment_name"] for u in only_type(result)["units"]]
        assert names == ["펌프-003", "펌프-001", "펌프-002"]

    def test_unit_fields(self):
        result = compute_utilization([unit("t1", name="펌프-001")], [busy("t1", at(0), at(6))], DAY_START, DAY_END)

        assert only_type(result)["units"][0] == {
            "tag_id": "t1",
            "equipment_name": "펌프-001",
            "utilization": pytest.approx(0.25),
            "checkout_count": 1,
        }


class TestEmpty:
    def test_no_units(self):
        result = compute_utilization([], [], DAY_START, DAY_END)

        assert result["summary"] == {"utilization": 0, "shortage_type_count": 0, "idle_type_count": 0}
        assert result["types"] == []
        assert result["heatmap"]["by_type"] == {}
        assert result["hourly"]["by_type"] == {}
        assert all(value == 0 for value in result["hourly"]["all"]["weekday"] + result["hourly"]["all"]["weekend"])
        assert all(value == 0 for row in result["heatmap"]["all"] for value in row)

    def test_empty_period(self):
        result = compute_utilization([unit("a")], [busy("a", at(9), None)], DAY_END, DAY_END)

        assert only_type(result)["utilization"] == 0
