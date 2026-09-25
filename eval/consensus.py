"""합의 내결함성 실증 — 검증 노드를 실제로 내려 정족수 성질을 확인한다.

시나리오 14·15는 공격이 아니라 성질의 실증이다. QBFT는 비잔틴 결함을 허용하기 위해
전체 노드 수가 3f+1을 만족해야 하고, 노드 4대 구성의 정족수는 3이다. 1대가 빠져도
블록이 계속 만들어지고, 2대가 빠지면 정족수를 못 채워 새 블록이 멈춘다.

15번은 덤으로 블록체인이 멈춰도 대여와 반납은 성공한다는 설계를 함께 보인다. 기록만
남지 않을 뿐 장비 운용은 이어지고, 그 사이 생긴 이력은 위조가 아니라 검증 불가로
표시되어야 한다.

정족수 장악(3대)은 실험하지 않는다. 노드 3대를 장악했다는 것은 운영 주체가 곧
공격자라는 뜻이라, 시스템이 막을 대상이 아니라 신뢰 경계다.
"""

import subprocess
import time
from dataclasses import dataclass

VALIDATORS = ("besu-validator1", "besu-validator2", "besu-validator3", "besu-validator4")

# 노드를 내린 뒤 나머지가 상태를 감지할 때까지의 여유.
SETTLE_SEC = 10


@dataclass
class ConsensusResult:
    number: int
    stopped: int
    quorum: str
    anchored: bool
    expected: str
    matched: bool
    detail: str


def _docker(action: str, *names: str) -> None:
    subprocess.run(["docker", action, *names], check=True, capture_output=True, timeout=120)


def try_anchor() -> tuple[bool, str]:
    """대여와 반납을 수행해 새 기록이 체인에 실리는지 본다.

    블록 수를 세는 것보다 이쪽이 논문의 주장에 직결된다 — 묻는 것은 "정족수가 깨진
    동안에도 장비 운용은 이어지는가, 다만 기록만 남지 않는가"이다. 제네시스의
    blockperiodseconds가 30초라 짧은 창에서는 블록 수가 0으로 보이기도 한다.
    """
    from eval.integrity import create_anchored_usage

    try:
        usage_id = create_anchored_usage()
        return True, f"이력 {usage_id} 기록됨"
    except RuntimeError as error:
        return False, str(error)[:120]


def run_case(number: int, stop_count: int, expected: str) -> ConsensusResult:
    """검증 노드를 stop_count대 내리고 새 기록이 체인에 실리는지 본다."""
    targets = VALIDATORS[:stop_count]
    _docker("stop", *targets)
    try:
        time.sleep(SETTLE_SEC)
        anchored, detail = try_anchor()
    finally:
        _docker("start", *targets)
        time.sleep(SETTLE_SEC)

    alive = len(VALIDATORS) - stop_count
    return ConsensusResult(
        number=number,
        stopped=stop_count,
        quorum=f"{alive}/{len(VALIDATORS)} (정족수 3)",
        anchored=anchored,
        expected=expected,
        matched=anchored == (expected == "정상 동작"),
        detail=detail,
    )


def run() -> list[ConsensusResult]:
    return [
        run_case(14, 1, "정상 동작"),
        run_case(15, 2, "신규 기록 중단"),
    ]
