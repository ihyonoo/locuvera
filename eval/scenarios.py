"""변조 시나리오 — 무엇을 어떻게 건드리고 무엇을 기대하는지.

공격자의 등급이 올라갈수록 손댈 수 있는 범위가 넓어진다. 데이터베이스만 건드리는
내부자(A), 앵커 메타까지 바꾸는 백엔드 침해(B), 체인에 묻는 답을 지어내는 RPC 노드
장악(C)이다. 등급이 오를수록 앞 계층은 속고 뒤 계층이 잡는다.

잡히지 않아야 정상인 시나리오도 함께 돌린다. 표시용 항목은 기록 대상이 아니므로
바뀌어도 통과해야 하고, 변조하지 않은 이력은 당연히 통과해야 한다. 이 둘이 없으면
나머지 탐지가 "무엇이든 불일치로 뱉는 검증기"와 구분되지 않는다.
"""

from collections.abc import Callable
from dataclasses import dataclass

from eval import rpc_proxy

# 체인에 기록되는 항목과 그렇지 않은 항목. 선별 기준은 사실관계를 구성하는가이다.
ANCHORED_COLUMN = "anchored"
DISPLAY_COLUMN = "display"
ANCHOR_META_COLUMN = "anchor_meta"


@dataclass
class Scenario:
    number: int
    tier: str
    name: str
    expected: str
    catches: str
    kind: str
    # 등급 A·B — 바꿀 컬럼과 값을 만드는 함수
    column: str | None = None
    value: Callable[[object], object] | None = None
    # 등급 C — 프록시에 걸 규칙을 만드는 함수 (앵커 정보를 받는다)
    rules: Callable[[dict], list[rpc_proxy.Rule]] | None = None
    notes: str = ""


def _shift_seconds(delta: int) -> Callable[[object], object]:
    def value(current):
        return current + __import__("datetime").timedelta(seconds=delta)

    return value


def _blank_movement(_current):
    """거쳐 간 구역을 지운다. 기준 이력에 실제 경로가 있어야 변조가 성립한다."""
    return "[]"


def _rename(current):
    return f"{current}(변조)"


def _other_user(current):
    # 다른 사용자 식별자로 바꾼다. 1번은 시드의 첫 직원이라 항상 존재한다.
    return 1 if current != 1 else 2


def _fake_hash(_current):
    return "0x" + "ab" * 32


def _shift_block(current):
    return (current or 0) + 1


SCENARIOS: list[Scenario] = [
    Scenario(
        1,
        "A",
        "대여자 식별자 변조",
        "불일치",
        "컨트랙트 상태",
        ANCHORED_COLUMN,
        column="user_id",
        value=_other_user,
    ),
    Scenario(
        2,
        "A",
        "반납 시각 변조",
        "불일치",
        "컨트랙트 상태",
        ANCHORED_COLUMN,
        column="returned_at",
        value=_shift_seconds(600),
    ),
    Scenario(
        3,
        "A",
        "이동 경로 변조",
        "불일치",
        "컨트랙트 상태",
        ANCHORED_COLUMN,
        column="movement_path",
        value=_blank_movement,
    ),
    Scenario(
        4,
        "A",
        "장비명 변조 — 표시용",
        "검증됨",
        "없음 — 기록 대상이 아님",
        DISPLAY_COLUMN,
        column="equipment_name",
        value=_rename,
        notes="통과가 정상. 기록 항목 선별이 의도대로 작동했다는 근거다.",
    ),
    Scenario(
        5,
        "B",
        "트랜잭션 해시 변조",
        "불일치",
        "앵커 해석",
        ANCHOR_META_COLUMN,
        column="blockchain_tx_hash",
        value=_fake_hash,
    ),
    Scenario(
        6,
        "B",
        "블록 번호 변조 — 지목 수단",
        "검증됨",
        "없음 — 영수증에서 다시 찾는다",
        ANCHOR_META_COLUMN,
        column="blockchain_block_number",
        value=_shift_block,
        notes="통과가 정상. 블록 번호는 검증 근거가 아니라 대상을 지목하는 수단이라, "
        "트랜잭션 해시만 맞으면 영수증에서 진짜 블록을 다시 찾아낸다.",
    ),
    Scenario(
        7,
        "C",
        "컨트랙트 상태 응답 위조",
        "불일치",
        "이벤트 로그",
        "proxy",
        rules=lambda anchor: [rpc_proxy.Rule("eth_call", rpc_proxy.replace_field(1, 999))],
    ),
    Scenario(
        8,
        "C",
        "상태 + 이벤트 로그 위조",
        "불일치",
        "트랜잭션 입력",
        "proxy",
        rules=lambda anchor: [
            rpc_proxy.Rule("eth_call", rpc_proxy.replace_field(1, 999)),
            rpc_proxy.Rule("eth_getLogs", rpc_proxy.drop_results()),
        ],
    ),
    Scenario(
        9,
        "C",
        "트랜잭션 입력 위조",
        "불일치",
        "서명 · 머클 루트",
        "proxy",
        rules=lambda anchor: [
            rpc_proxy.Rule("eth_getBlockByHash", rpc_proxy.patch_transaction_input(anchor["tx_hash"], "0xdeadbeef")),
            rpc_proxy.Rule("eth_getBlockByNumber", rpc_proxy.patch_transaction_input(anchor["tx_hash"], "0xdeadbeef")),
        ],
    ),
    Scenario(
        10,
        "C",
        "블록 트랜잭션 목록 위조",
        "불일치",
        "머클 루트",
        "proxy",
        rules=lambda anchor: [
            rpc_proxy.Rule("eth_getBlockByHash", rpc_proxy.drop_transaction(anchor["tx_hash"])),
            rpc_proxy.Rule("eth_getBlockByNumber", rpc_proxy.drop_transaction(anchor["tx_hash"])),
        ],
    ),
    Scenario(
        11,
        "—",
        "동일 식별자로 재기록 시도",
        "요청 거절",
        "컨트랙트 자체",
        "rerecord",
        notes="불변성을 컨트랙트 수준에서 한 번 더 강제하는지 본다.",
    ),
    Scenario(
        12,
        "—",
        "체인에 기록되지 않은 이력",
        "검증 불가",
        "해당 없음",
        "unanchored",
        notes="위조가 아니라 검증 불가로 나와야 한다. 체인 장애가 사고로 보고되면 안 된다.",
    ),
    Scenario(
        13,
        "—",
        "정상 이력 — 변조 없음",
        "검증됨",
        "오탐 확인",
        "baseline",
        notes="검증기가 무차별로 불일치를 뱉지 않음을 보인다.",
    ),
]

# 기대 판정을 구현의 판정 상태로 옮긴 것. 여러 상태가 같은 결론에 해당한다.
EXPECTED_STATUSES: dict[str, set[str]] = {
    "검증됨": {"verified"},
    "불일치": {
        "db_mismatch",
        "tx_input_mismatch",
        "tx_sender_mismatch",
        "transactions_root_mismatch",
        "tx_not_in_block",
        "onchain_missing",
        "anchor_unresolved",
        "transaction_missing",
    },
    "검증 불가": {"onchain_missing", "anchor_unresolved", "not_configured", "not_eligible"},
    "요청 거절": {"rejected"},
}


def matches_expectation(scenario: Scenario, status: str) -> bool:
    return status in EXPECTED_STATUSES.get(scenario.expected, set())
