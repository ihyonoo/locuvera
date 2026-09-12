"""BLE 전파 모델 — 경로손실 + 벽 감쇠 + 노이즈 + 수신 판정.

RSSI(d) = RSSI_AT_1M - 10*n*log10(d) - WALL_ATTENUATION_DB*(벽 통과 수) + 개체차 + 노이즈

벽 통과 수는 태그 구역과 리더 구역 사이 그래프 홉 수로 근사한다. 이동 중에는 출발
구역과 목적 구역의 홉 수를 진행률로 보간해 RSSI가 계단식으로 튀지 않게 한다.
"""

import math
import random

# iBeacon TX 0dBm 기준 1m 수신 세기.
RSSI_AT_1M = -59.0
# 실내 복도 경로손실 지수.
PATH_LOSS_EXPONENT = 2.0
# 벽 하나를 통과할 때 감쇠량.
WALL_ATTENUATION_DB = 6.0

# 수신 감도. 이보다 약하면 광고 패킷이 아예 안 잡힌다.
RX_SENSITIVITY_DBM = -95.0
# 감도 바로 위 구간에서 수신 확률이 선형으로 떨어지는 폭.
RX_FADE_MARGIN_DB = 10.0

# 이 거리를 넘으면 계산을 생략한다(항상 감도 아래).
MAX_RANGE_M = 40.0

# 샘플마다 흔들리는 빠른 페이딩.
FAST_NOISE_SIGMA_DB = 2.5
# 자세·멀티패스 변화를 나타내는 느린 성분.
SLOW_NOISE_SIGMA_DB = 1.5
SLOW_NOISE_TAU_SEC = 30.0
# 태그마다 TX 파워가 미세하게 다르다.
TAG_TX_SIGMA_DB = 1.5


def path_loss_rssi(distance_m: float, wall_hops: float) -> float:
    """노이즈 없는 기준 RSSI. 1m 미만은 근거리 모델이 무너지므로 1m로 자른다."""
    effective_distance = max(distance_m, 1.0)
    loss = 10.0 * PATH_LOSS_EXPONENT * math.log10(effective_distance)
    return RSSI_AT_1M - loss - WALL_ATTENUATION_DB * wall_hops


def reception_probability(rssi: float) -> float:
    """감도 위 FADE_MARGIN 구간에서 선형으로 감소하는 패킷 수신 확률."""
    if rssi <= RX_SENSITIVITY_DBM:
        return 0.0
    margin = rssi - RX_SENSITIVITY_DBM
    if margin >= RX_FADE_MARGIN_DB:
        return 1.0
    return margin / RX_FADE_MARGIN_DB


def tag_tx_offset(tag_id: str) -> float:
    """태그별 고정 TX 개체차. tag_id에서 결정론적으로 뽑아 재시작해도 동일하다."""
    return random.Random(f"tx:{tag_id}").gauss(0.0, TAG_TX_SIGMA_DB)


class SlowFading:
    """(태그, 리더) 쌍마다 도는 Ornstein-Uhlenbeck 과정.

    시정수 SLOW_NOISE_TAU_SEC로 0을 향해 되돌아가면서, 정상상태 표준편차가
    SLOW_NOISE_SIGMA_DB가 되도록 잡음을 더한다. 인접 틱끼리 상관되어 있어야
    실제 전파처럼 서서히 흔들린다.
    """

    def __init__(self) -> None:
        self._state: dict[tuple[str, str], float] = {}

    def value(self, key: tuple[str, str], dt_sec: float, rng: random.Random) -> float:
        decay = math.exp(-dt_sec / SLOW_NOISE_TAU_SEC)
        noise_scale = SLOW_NOISE_SIGMA_DB * math.sqrt(max(0.0, 1.0 - decay * decay))
        current = self._state.get(key, 0.0) * decay + rng.gauss(0.0, noise_scale)
        self._state[key] = current
        return current


def sample_rssi(base_rssi: float, tx_offset: float, slow_offset: float, rng: random.Random) -> float:
    return base_rssi + tx_offset + slow_offset + rng.gauss(0.0, FAST_NOISE_SIGMA_DB)
