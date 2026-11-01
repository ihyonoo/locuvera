"""수요 곡선 — 시간대·요일 배율과 동시 대여량 피드백 제어.

장비를 두 클래스로 나눈다. 급성기 계열은 24시간 돌고 주말 영향이 적다. 외래 계열은
진료 시간에 몰리고 야간·일요일에는 거의 멈춘다. 이것이 "장비마다 사용 빈도가 다르다"의
핵심이다 — 단일 곡선으로는 응급실 제세동기와 외래 초음파가 같은 리듬으로 움직인다.
"""

import datetime as dt

from simulation.topology.equipment import DemandClass, EquipmentType

KST = dt.timezone(dt.timedelta(hours=9))

# 급성기 계열 시간대 배율. 인계·회진이 몰리는 오전과 오후에 봉우리가 있다.
ACUTE_HOURLY: tuple[float, ...] = (
    0.45, 0.42, 0.40, 0.40, 0.42, 0.48,  # 00~05시
    0.60, 0.75, 0.90, 1.00, 1.00, 0.95,  # 06~11시
    0.85, 0.90, 0.95, 0.95, 0.90, 0.85,  # 12~17시
    0.78, 0.70, 0.65, 0.60, 0.55, 0.50,  # 18~23시
)  # fmt: skip

# 외래 계열 시간대 배율. 12시 급락은 점심시간이다.
OUTPATIENT_HOURLY: tuple[float, ...] = (
    0.05, 0.04, 0.03, 0.03, 0.03, 0.04,  # 00~05시
    0.08, 0.20, 0.60, 0.95, 1.00, 0.95,  # 06~11시
    0.55, 0.85, 1.00, 0.95, 0.85, 0.70,  # 12~17시
    0.40, 0.20, 0.12, 0.08, 0.06, 0.05,  # 18~23시
)  # fmt: skip

_HOURLY = {DemandClass.ACUTE: ACUTE_HOURLY, DemandClass.OUTPATIENT: OUTPATIENT_HOURLY}

# 요일 배율. weekday()는 월=0, 토=5, 일=6.
_ACUTE_BY_WEEKDAY = (1.0, 1.0, 1.0, 1.0, 1.0, 0.90, 0.80)
_OUTPATIENT_BY_WEEKDAY = (1.0, 1.0, 1.0, 1.0, 1.0, 0.45, 0.05)
# 토요일 외래는 오전 진료만 한다.
SATURDAY_AFTERNOON_HOUR = 13
SATURDAY_AFTERNOON_MULTIPLIER = 0.05

# 목표 동시 대여 밴드. 아래 만성 부족 5종(19대)은 세지 않으므로 나머지 31대 기준이다.
DAY_BAND = (5, 9)
NIGHT_BAND = (1, 3)
NIGHT_START_HOUR = 23
NIGHT_END_HOUR = 7

# 만성 부족 장비 — 중환자실·분만실에서 늘 모자라는 급성기 5종.
# 동시 대여 수에 세지 않고 피드백도 받지 않는다. 세면 나머지 장비의 대여가 피드백 하한까지 깎인다.
BAND_EXEMPT_SLUGS = frozenset({"syringe", "monitor", "vent", "suction", "ctg"})

# 피드백 계수 범위. 개별 이벤트의 확률성을 죽이지 않도록 좁게 잡는다.
FEEDBACK_MIN = 0.5
FEEDBACK_MAX = 1.5
FEEDBACK_GAIN = 0.15

# 야간 응급 상황 버스트.
NIGHT_SURGE_PROB_PER_HOUR = 0.04
NIGHT_SURGE_MULTIPLIER = 3.0
NIGHT_SURGE_MIN_SEC = 300.0
NIGHT_SURGE_MAX_SEC = 900.0


def _kst(moment: dt.datetime) -> dt.datetime:
    return moment.astimezone(KST)


def hour_multiplier(demand_class: DemandClass, moment: dt.datetime) -> float:
    return _HOURLY[demand_class][_kst(moment).hour]


def day_multiplier(demand_class: DemandClass, moment: dt.datetime) -> float:
    local = _kst(moment)
    if demand_class is DemandClass.ACUTE:
        return _ACUTE_BY_WEEKDAY[local.weekday()]
    if local.weekday() == 5 and local.hour >= SATURDAY_AFTERNOON_HOUR:
        return SATURDAY_AFTERNOON_MULTIPLIER
    return _OUTPATIENT_BY_WEEKDAY[local.weekday()]


def activity(demand_class: DemandClass, moment: dt.datetime) -> float:
    return hour_multiplier(demand_class, moment) * day_multiplier(demand_class, moment)


def is_night(moment: dt.datetime) -> bool:
    hour = _kst(moment).hour
    return hour >= NIGHT_START_HOUR or hour < NIGHT_END_HOUR


def target_band(moment: dt.datetime) -> tuple[int, int]:
    return NIGHT_BAND if is_night(moment) else DAY_BAND


def feedback_factor(concurrent: int, band: tuple[int, int]) -> float:
    """동시 대여 수를 목표 밴드로 되돌리는 완만한 보정."""
    low, high = band
    if concurrent < low:
        factor = 1.0 + (low - concurrent) * FEEDBACK_GAIN
    elif concurrent > high:
        factor = 1.0 - (concurrent - high) * FEEDBACK_GAIN
    else:
        factor = 1.0
    return min(FEEDBACK_MAX, max(FEEDBACK_MIN, factor))


class NightSurge:
    """야간 응급 상황 버스트.

    시작 판정은 행동 틱마다 한 번만(maybe_start), 배율 조회는 장비마다(factor) 한다.
    장비별로 시작 판정을 돌리면 50번 굴려 사실상 매 틱 버스트가 터진다.
    """

    def __init__(self) -> None:
        self._until = 0.0

    def maybe_start(self, moment: dt.datetime, now: float, interval_sec: float, rng) -> None:
        if now < self._until or not is_night(moment):
            return
        if rng.random() < NIGHT_SURGE_PROB_PER_HOUR * interval_sec / 3600.0:
            self._until = now + rng.uniform(NIGHT_SURGE_MIN_SEC, NIGHT_SURGE_MAX_SEC)

    def factor(self, demand_class: DemandClass, now: float) -> float:
        if demand_class is not DemandClass.ACUTE or now >= self._until:
            return 1.0
        return NIGHT_SURGE_MULTIPLIER


def effective_feedback(profile: EquipmentType, feedback: float) -> float:
    return 1.0 if profile.slug in BAND_EXEMPT_SLUGS else feedback


def checkout_probability(profile: EquipmentType, moment: dt.datetime, feedback: float, interval_sec: float) -> float:
    """이번 행동 틱에서 이 장비 한 대가 대여될 확률."""
    rate_per_sec = profile.checkout_rate_per_hour / 3600.0
    expected = rate_per_sec * interval_sec * activity(profile.demand_class, moment) * feedback
    return min(1.0, max(0.0, expected))
