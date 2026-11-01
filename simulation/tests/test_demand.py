import datetime as dt
import random

from simulation import demand
from simulation.topology.equipment import TYPES, DemandClass

WEEKDAY_10AM = dt.datetime(2026, 8, 12, 10, 0, tzinfo=demand.KST)  # 수요일
WEEKDAY_3AM = dt.datetime(2026, 8, 12, 3, 0, tzinfo=demand.KST)
SATURDAY_10AM = dt.datetime(2026, 8, 15, 10, 0, tzinfo=demand.KST)
SATURDAY_3PM = dt.datetime(2026, 8, 15, 15, 0, tzinfo=demand.KST)
SUNDAY_10AM = dt.datetime(2026, 8, 16, 10, 0, tzinfo=demand.KST)


class TestHourlyCurves:
    def test_both_curves_have_24_entries(self):
        assert len(demand.ACUTE_HOURLY) == 24
        assert len(demand.OUTPATIENT_HOURLY) == 24

    def test_all_multipliers_are_between_zero_and_one(self):
        for curve in (demand.ACUTE_HOURLY, demand.OUTPATIENT_HOURLY):
            assert all(0.0 <= value <= 1.0 for value in curve)

    def test_both_curves_peak_at_one(self):
        assert max(demand.ACUTE_HOURLY) == 1.0
        assert max(demand.OUTPATIENT_HOURLY) == 1.0

    def test_acute_equipment_stays_busy_at_night(self):
        assert demand.hour_multiplier(DemandClass.ACUTE, WEEKDAY_3AM) >= 0.35

    def test_outpatient_equipment_is_nearly_idle_at_night(self):
        assert demand.hour_multiplier(DemandClass.OUTPATIENT, WEEKDAY_3AM) <= 0.05

    def test_outpatient_curve_dips_at_lunch(self):
        assert demand.OUTPATIENT_HOURLY[12] < demand.OUTPATIENT_HOURLY[11]
        assert demand.OUTPATIENT_HOURLY[12] < demand.OUTPATIENT_HOURLY[13]

    def test_uses_kst_regardless_of_the_process_timezone(self):
        utc_moment = dt.datetime(2026, 8, 12, 1, 0, tzinfo=dt.UTC)  # KST 10시
        assert demand.hour_multiplier(DemandClass.OUTPATIENT, utc_moment) == demand.OUTPATIENT_HOURLY[10]


class TestDayMultiplier:
    def test_weekdays_are_the_baseline(self):
        assert demand.day_multiplier(DemandClass.ACUTE, WEEKDAY_10AM) == 1.0
        assert demand.day_multiplier(DemandClass.OUTPATIENT, WEEKDAY_10AM) == 1.0

    def test_outpatient_collapses_on_sunday(self):
        assert demand.day_multiplier(DemandClass.OUTPATIENT, SUNDAY_10AM) <= 0.1

    def test_acute_barely_changes_on_sunday(self):
        assert demand.day_multiplier(DemandClass.ACUTE, SUNDAY_10AM) >= 0.7

    def test_saturday_outpatient_runs_in_the_morning_only(self):
        morning = demand.day_multiplier(DemandClass.OUTPATIENT, SATURDAY_10AM)
        afternoon = demand.day_multiplier(DemandClass.OUTPATIENT, SATURDAY_3PM)
        assert morning > afternoon
        assert afternoon <= 0.1


class TestTargetBand:
    def test_daytime_band(self):
        assert demand.target_band(WEEKDAY_10AM) == (5, 9)

    def test_nighttime_band(self):
        assert demand.target_band(WEEKDAY_3AM) == (1, 3)


class TestFeedbackFactor:
    def test_is_neutral_inside_the_band(self):
        assert demand.feedback_factor(11, (8, 14)) == 1.0

    def test_pushes_up_below_the_band(self):
        assert demand.feedback_factor(3, (8, 14)) > 1.0

    def test_pushes_down_above_the_band(self):
        assert demand.feedback_factor(20, (8, 14)) < 1.0

    def test_is_clamped_to_the_allowed_range(self):
        assert demand.feedback_factor(0, (8, 14)) <= demand.FEEDBACK_MAX
        assert demand.feedback_factor(500, (8, 14)) >= demand.FEEDBACK_MIN

    def test_is_monotonic_in_the_concurrent_count(self):
        values = [demand.feedback_factor(n, (8, 14)) for n in range(0, 30)]
        assert values == sorted(values, reverse=True)


class TestBandExemption:
    def test_exempt_types_ignore_feedback(self):
        for slug in demand.BAND_EXEMPT_SLUGS:
            assert demand.effective_feedback(TYPES[slug], 0.5) == 1.0

    def test_other_types_keep_feedback(self):
        for slug, profile in TYPES.items():
            if slug not in demand.BAND_EXEMPT_SLUGS:
                assert demand.effective_feedback(profile, 0.5) == 0.5

    def test_exempt_types_are_acute_and_not_essential(self):
        # 외래 계열은 야간·주말에 쉬므로 만성 부족 대상이 아니다
        for slug in demand.BAND_EXEMPT_SLUGS:
            assert TYPES[slug].demand_class is DemandClass.ACUTE
        assert not demand.BAND_EXEMPT_SLUGS & {"defib", "crash", "pump"}


class TestNightSurge:
    def test_is_neutral_before_anything_starts(self):
        surge = demand.NightSurge()
        assert surge.factor(DemandClass.ACUTE, 1000.0) == 1.0

    def test_never_starts_during_the_day(self):
        surge = demand.NightSurge()
        rng = random.Random(1)
        for step in range(5000):
            surge.maybe_start(WEEKDAY_10AM, 1000.0 + step * 10.0, 10.0, rng)
        assert surge.factor(DemandClass.ACUTE, 1000.0) == 1.0

    def test_eventually_starts_at_night(self):
        surge = demand.NightSurge()
        rng = random.Random(2)
        now = 1000.0
        for _ in range(20_000):
            now += 10.0
            surge.maybe_start(WEEKDAY_3AM, now, 10.0, rng)
            if surge.factor(DemandClass.ACUTE, now) > 1.0:
                return
        raise AssertionError("야간 버스트가 한 번도 시작되지 않았다")

    def test_only_boosts_acute_equipment(self):
        surge = demand.NightSurge()
        rng = random.Random(3)
        now = 1000.0
        while surge.factor(DemandClass.ACUTE, now) == 1.0:
            now += 10.0
            surge.maybe_start(WEEKDAY_3AM, now, 10.0, rng)
        assert surge.factor(DemandClass.ACUTE, now) == demand.NIGHT_SURGE_MULTIPLIER
        assert surge.factor(DemandClass.OUTPATIENT, now) == 1.0

    def test_expires_within_the_declared_window(self):
        surge = demand.NightSurge()
        rng = random.Random(4)
        now = 1000.0
        while surge.factor(DemandClass.ACUTE, now) == 1.0:
            now += 10.0
            surge.maybe_start(WEEKDAY_3AM, now, 10.0, rng)
        assert surge.factor(DemandClass.ACUTE, now + demand.NIGHT_SURGE_MAX_SEC + 1.0) == 1.0


class TestCheckoutProbability:
    def test_scales_with_the_interval(self):
        from simulation.topology.equipment import TYPES

        profile = TYPES["pump"]
        short = demand.checkout_probability(profile, WEEKDAY_10AM, 1.0, 10.0)
        long = demand.checkout_probability(profile, WEEKDAY_10AM, 1.0, 20.0)
        assert long > short

    def test_never_exceeds_one(self):
        from simulation.topology.equipment import TYPES

        assert demand.checkout_probability(TYPES["speccart"], WEEKDAY_10AM, 1.5, 100_000.0) <= 1.0

    def test_high_rate_types_are_more_likely_than_low_rate_types(self):
        from simulation.topology.equipment import TYPES

        cart = demand.checkout_probability(TYPES["speccart"], WEEKDAY_10AM, 1.0, 10.0)
        defib = demand.checkout_probability(TYPES["defib"], WEEKDAY_10AM, 1.0, 10.0)
        assert cart > defib * 10

    def test_outpatient_equipment_is_essentially_dormant_at_night(self):
        from simulation.topology.equipment import TYPES

        night = demand.checkout_probability(TYPES["estim"], WEEKDAY_3AM, 1.0, 10.0)
        day = demand.checkout_probability(TYPES["estim"], WEEKDAY_10AM, 1.0, 10.0)
        assert night < day * 0.1
