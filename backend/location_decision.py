"""위치 판정 규칙 — 태그의 관측표와 현재 상태로 구역 전환 여부를 결정한다.

/ingest가 호출하는 순수 함수로 분리해 둔다. 같은 규칙을 기록해 둔 관측 트레이스에
다시 적용할 수 있어야, 파라미터를 바꿔가며 판정 품질을 평가할 수 있다.
"""

from dataclasses import dataclass

try:
    from backend.settings import DWELL_SEC, HYST_DB, STALE_SEC
except ModuleNotFoundError:
    from settings import DWELL_SEC, HYST_DB, STALE_SEC

# 현재 리더의 관측이 만료됐을 때 비교에 쓰는 값.
# 어떤 후보에게도 지게 만들어, 갱신이 끊긴 리더가 히스테리시스 뒤에 숨지 못하게 한다.
STALE_RSSI = -999


@dataclass(frozen=True)
class DecisionParams:
    hyst_db: int = HYST_DB
    dwell_sec: int = DWELL_SEC
    stale_sec: int = STALE_SEC
    # 0이면 만료 전까지 값을 그대로 쓰는 계단식이다. 양수면 경과 시간에 비례해 값을 깎아,
    # 낡은 관측이 방금 들어온 값과 같은 무게로 경쟁하지 않게 한다.
    decay_db_per_sec: float = 0.0


DEFAULT_PARAMS = DecisionParams()


def new_tag_state() -> dict:
    return {
        "current_reader": None,
        "current_rssi": None,
        "candidate_reader": None,
        "candidate_since": None,
        "updated_at": None,
    }


def effective_rssi(observation: dict, now: int, decay_db_per_sec: float) -> float:
    """경과 시간만큼 깎은 신호 세기. 감쇠가 0이면 기록된 값 그대로다."""
    if not decay_db_per_sec:
        return observation["rssi"]
    return observation["rssi"] - decay_db_per_sec * (now - observation["recv_ts"])


def pick_best_reader(
    observations: dict[str, dict],
    now: int,
    stale_sec: int = STALE_SEC,
    decay_db_per_sec: float = 0.0,
):
    """신선한 관측 중 신호가 가장 강한 (reader_id, rssi, recv_ts). 하나도 없으면 None."""
    candidates = [
        (reader_id, effective_rssi(observation, now, decay_db_per_sec), observation["recv_ts"])
        for reader_id, observation in observations.items()
        if now - observation["recv_ts"] <= stale_sec
    ]

    if not candidates:
        return None

    candidates.sort(key=lambda item: item[1], reverse=True)
    return candidates[0]


def decide_transition(
    observations: dict[str, dict],
    state: dict,
    now: int,
    params: DecisionParams = DEFAULT_PARAMS,
) -> tuple[str, int | None, int] | None:
    """전환 여부를 판정한다. state는 제자리에서 갱신된다.

    전환이 확정되면 기록에 쓸 (reader_id, rssi, now)를, 아니면 None을 돌려준다.
    """
    best = pick_best_reader(observations, now, params.stale_sec, params.decay_db_per_sec)
    if best is None:
        return None

    best_reader_id, best_rssi, _recv_ts = best

    current_reader = state["current_reader"]
    if current_reader is None:
        state["current_reader"] = best_reader_id
        state["current_rssi"] = best_rssi
        state["updated_at"] = now
        state["candidate_reader"] = None
        state["candidate_since"] = None
        return (best_reader_id, best_rssi, now)

    current_observation = observations.get(current_reader)
    current_rssi = (
        effective_rssi(current_observation, now, params.decay_db_per_sec)
        if current_observation and (now - current_observation["recv_ts"] <= params.stale_sec)
        else STALE_RSSI
    )

    if best_reader_id == current_reader:
        state["current_rssi"] = best_rssi
        state["candidate_reader"] = None
        state["candidate_since"] = None
        state["updated_at"] = now
        return None

    if best_rssi - current_rssi < params.hyst_db:
        state["candidate_reader"] = None
        state["candidate_since"] = None
        state["current_rssi"] = current_rssi
        state["updated_at"] = now
        return None

    if state["candidate_reader"] != best_reader_id:
        state["candidate_reader"] = best_reader_id
        state["candidate_since"] = now
        return None

    if state["candidate_since"] and (now - state["candidate_since"] >= params.dwell_sec):
        state["current_reader"] = best_reader_id
        state["current_rssi"] = best_rssi
        state["updated_at"] = now
        state["candidate_reader"] = None
        state["candidate_since"] = None
        return (best_reader_id, best_rssi, now)

    return None
