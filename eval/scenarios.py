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
    # 공격 목적. 은폐는 변조를 정상으로 통과시키려는 것이고, 훼손은 정상 기록을
    # 변조된 것처럼 보이게 만들려는 것이다. 증거가 목적인 시스템에서는 둘 다 공격이다.
    goal: str = "은폐"
    # 등급 A·B — 바꿀 컬럼과 값을 만드는 함수
    column: str | None = None
    value: Callable[[object], object] | None = None
    # 등급 C — 프록시에 걸 규칙을 만드는 함수 (앵커 정보를 받는다)
    rules: Callable[[dict], list[rpc_proxy.Rule]] | None = None
    # 데이터베이스 값을 체인에 실린 정수로 옮긴다. 프록시가 그 값을 찾아 바꿔야 한다.
    chain_value: Callable[[object], int] | None = None
    # 앵커 메타를 비워 이벤트 로그 경로를 타게 한다.
    clear_anchor: bool = False
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


def _epoch(value) -> int:
    """반납 시각을 체인에 실린 에포크 정수로 옮긴다.

    데이터베이스는 EXTRACT(EPOCH ...)::BIGINT로 꺼내는데 numeric을 bigint로 캐스팅하면
    반올림된다. 파이썬의 int()는 버림이라, 소수부가 0.5를 넘는 시각에서 1초씩 어긋나
    프록시가 바꿀 값을 찾지 못한다.
    """
    return round(value.timestamp())


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
        rules=lambda ctx: [rpc_proxy.Rule("eth_call", rpc_proxy.replace_field(1, 999))],
        goal="훼손",
        notes="정상 기록이 불일치로 표시된다 — 훼손 공격은 성공한다. "
        "검증 결과만으로는 DB 변조와 노드의 거짓말을 구분하지 못한다.",
    ),
    Scenario(
        8,
        "C",
        "상태 + 이벤트 로그 위조",
        "불일치",
        "트랜잭션 입력",
        "proxy",
        rules=lambda ctx: [
            rpc_proxy.Rule("eth_call", rpc_proxy.replace_field(1, 999)),
            rpc_proxy.Rule("eth_getLogs", rpc_proxy.drop_results()),
        ],
        goal="훼손",
    ),
    Scenario(
        9,
        "C",
        "트랜잭션 입력 위조",
        "불일치",
        "서명 · 머클 루트",
        "proxy",
        rules=lambda ctx: [
            rpc_proxy.Rule(
                "eth_getBlockByHash", rpc_proxy.patch_transaction_input(ctx["anchor"]["tx_hash"], "0xdeadbeef")
            ),
            rpc_proxy.Rule(
                "eth_getBlockByNumber", rpc_proxy.patch_transaction_input(ctx["anchor"]["tx_hash"], "0xdeadbeef")
            ),
        ],
        goal="훼손",
    ),
    Scenario(
        10,
        "C",
        "블록 트랜잭션 목록 위조",
        "불일치",
        "머클 루트",
        "proxy",
        rules=lambda ctx: [
            rpc_proxy.Rule("eth_getBlockByHash", rpc_proxy.drop_transaction(ctx["anchor"]["tx_hash"])),
            rpc_proxy.Rule("eth_getBlockByNumber", rpc_proxy.drop_transaction(ctx["anchor"]["tx_hash"])),
        ],
        goal="훼손",
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
    Scenario(
        16,
        "C",
        "상태를 변조에 맞춰 위조",
        "불일치",
        "트랜잭션 입력",
        "conceal",
        column="returned_at",
        value=_shift_seconds(600),
        chain_value=_epoch,
        rules=lambda ctx: [rpc_proxy.Rule("eth_call", rpc_proxy.replace_word(ctx["before"], ctx["after"]))],
        notes="컨트랙트 상태 계층은 통과한다. 서명된 호출 원본이 남아 있어 다음 계층이 잡는다. "
        "변조 대상으로 반납 시각을 쓰는 이유는, 작은 정수는 ABI 인코딩의 구조 워드와 값이 겹쳐 "
        "엉뚱한 자리까지 바뀌기 때문이다.",
    ),
    Scenario(
        17,
        "C",
        "상태 + 입력까지 위조",
        "불일치",
        "서명",
        "conceal",
        column="returned_at",
        value=_shift_seconds(600),
        chain_value=_epoch,
        rules=lambda ctx: [
            rpc_proxy.Rule("eth_call", rpc_proxy.replace_word(ctx["before"], ctx["after"])),
            rpc_proxy.Rule(
                "eth_getBlockByHash",
                rpc_proxy.patch_transaction_word(ctx["anchor"]["tx_hash"], ctx["before"], ctx["after"]),
            ),
            rpc_proxy.Rule(
                "eth_getBlockByNumber",
                rpc_proxy.patch_transaction_word(ctx["anchor"]["tx_hash"], ctx["before"], ctx["after"]),
            ),
        ],
        notes="입력을 고치면 서명이 깨진다. 개인키가 없으면 여기서 막힌다.",
    ),
    Scenario(
        18,
        "C",
        "앵커를 지우고 상태 위조",
        "불일치",
        "이벤트 로그 · 트랜잭션 입력",
        "conceal",
        column="returned_at",
        value=_shift_seconds(600),
        chain_value=_epoch,
        clear_anchor=True,
        rules=lambda ctx: [rpc_proxy.Rule("eth_call", rpc_proxy.replace_word(ctx["before"], ctx["after"]))],
        notes="앵커가 없으면 검증이 이벤트 로그로 트랜잭션을 찾는다. 평소에는 타지 않는 경로다.",
    ),
    Scenario(
        19,
        "C",
        "앵커를 지우고 상태·이벤트 위조",
        "불일치",
        "트랜잭션 입력",
        "conceal",
        column="returned_at",
        value=_shift_seconds(600),
        chain_value=_epoch,
        clear_anchor=True,
        rules=lambda ctx: [
            rpc_proxy.Rule("eth_call", rpc_proxy.replace_word(ctx["before"], ctx["after"])),
            rpc_proxy.Rule("eth_getLogs", rpc_proxy.drop_results()),
        ],
        notes="이벤트까지 지우면 앵커를 찾지 못한다.",
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
