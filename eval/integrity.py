"""무결성 검증 평가 — 변조를 가하고 검증이 무엇을 돌려주는지 수집한다.

측위가 연속적인 수치를 재는 실험이라면 이쪽은 이산적인 판정을 재는 실험이다. 결과물은
교환 곡선이 아니라 시나리오별 탐지 표다.

가상 시계를 쓸 수 없다. 실제로 블록이 만들어지고 확정되어야 검증할 대상이 생기므로
백엔드·데이터베이스·Besu를 모두 띄운 상태에서 돈다.

검증은 백엔드가 쓰는 함수를 그대로 부른다. 온체인 스크립트가 환경변수를 상속하므로,
이 프로세스에서 RPC 주소만 프록시로 돌리면 노드를 장악한 공격자를 재현할 수 있다.
"""

import contextlib
import csv
import datetime as dt
import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path

import psycopg

from backend.auth_utils import build_auth_token
from backend.settings import DATABASE_URL
from backend.usage_history_service import (
    fetch_usage_record_for_chain,
    query_usage_history_rows,
    read_usage_record_from_chain,
    run_besu_script,
    verify_usage_history_integrity,
)
from eval import rpc_proxy
from eval.scenarios import SCENARIOS, Scenario, matches_expectation

BACKEND = "http://localhost:8000"
HTTP_TIMEOUT_SEC = 120
BESU_RPC_URL = os.environ.get("BESU_RPC_URL", "http://127.0.0.1:8549")

# 체인에서 비어 있는 식별자 구간. 데이터베이스를 재시드하면 식별자가 1부터 다시
# 시작하는데 체인에는 예전 기록이 남아 있어, 그대로 쓰면 재기록 거절에 걸린다.
USAGE_ID_BASE = 900_000

# 블록 주기가 30초라, 기록이 확정될 때까지 한 주기 이상 기다려야 할 때가 있다.
ANCHOR_WAIT_TRIES = 4
ANCHOR_WAIT_SEC = 20

# 체인에 올라가는 항목. 표시용 항목과 구분해 두어야 시나리오 4의 통과를 설명할 수 있다.
ANCHORED_COLUMNS = {"user_id", "returned_by_user_id", "returned_at", "checkout_at", "movement_path"}


@dataclass
class Result:
    run: int
    number: int
    tier: str
    name: str
    expected: str
    status: str
    matched: bool
    catches: str
    mismatch_fields: str
    db_matches_onchain: bool | None
    db_matches_event: bool | None
    tx_input_matches_db: bool | None
    tx_sender_matches: bool | None
    transactions_root_matches: bool | None
    tx_included_in_block: bool | None
    detail: str


FIELDS = tuple(Result.__dataclass_fields__)


# --- 기반 --------------------------------------------------------------------


def _query(sql: str, params: tuple = (), *, fetch: bool = True):
    with psycopg.connect(DATABASE_URL) as connection, connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall() if fetch else None


def api(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, dict]:
    request = urllib.request.Request(
        BACKEND + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SEC) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def token_for(user_id: int) -> str:
    """비밀번호를 거치지 않고 세션 토큰을 만든다 — 평가는 로그인 절차를 시험하지 않는다."""
    token, _ = build_auth_token(user_id=user_id, token_version=0)
    return token


def reserve_usage_id_range() -> int:
    """체인에서 비어 있는 구간으로 식별자 시퀀스를 옮긴다."""
    base = USAGE_ID_BASE
    while True:
        result = read_usage_record_from_chain(base)
        record = result.get("record")
        if result.get("status") == "ok" and not (isinstance(record, dict) and record.get("exists")):
            break
        base += 1_000

    _query(f"ALTER SEQUENCE usage_history_usage_id_seq RESTART WITH {base}", fetch=False)
    return base


def create_anchored_usage(variant: int = 0) -> int:
    """대여와 반납을 실제 경로로 수행해 체인에 기록된 이력을 하나 만든다.

    variant를 바꾸면 다른 장비와 직원을 고른다. 반복 실행이 같은 이력을 되풀이하면
    그 이력에만 성립하는 우연을 걸러내지 못하므로, 대여 구역과 이동 경로가 달라지게 한다.
    """
    rows = _query(
        """
        SELECT nfc_token FROM tags
        WHERE is_real_hardware = FALSE AND asset_status = 'available' AND is_active
        ORDER BY tag_id OFFSET %s LIMIT 1
        """,
        (variant,),
    )
    if not rows:
        raise RuntimeError(f"대여 가능한 시뮬레이션 태그가 없다 (variant={variant})")
    nfc_token = rows[0][0]

    staff_rows = _query(
        "SELECT user_id FROM users WHERE role = 'staff' ORDER BY user_id OFFSET %s LIMIT 1",
        (variant,),
    )
    staff = token_for(staff_rows[0][0])
    status, body = api("POST", "/usage/checkout", staff, {"nfc_token": nfc_token})
    if status != 200:
        raise RuntimeError(f"/usage/checkout 실패: {status} {body}")

    _record_movement(nfc_token)

    status, body = api("POST", "/usage/return", staff, {"nfc_token": nfc_token})
    if status != 200:
        raise RuntimeError(f"/usage/return 실패: {status} {body}")

    usage_id, tx_hash = _query(
        "SELECT usage_id, blockchain_tx_hash FROM usage_history WHERE usage_status = 'returned' "
        "ORDER BY usage_id DESC LIMIT 1"
    )[0]
    if not tx_hash:
        _backfill_anchor(usage_id)
    return usage_id


def _backfill_anchor(usage_id: int) -> None:
    """앵커 메타가 비어 있으면 이벤트 로그에서 찾아 채운다.

    블록 주기가 30초인데 온체인 스크립트 타임아웃도 30초라, 반납 시점의 기록 호출이
    트랜잭션 확정을 못 기다리고 끊길 때가 있다. 기록 자체는 다음 블록에 실리므로 체인에는
    남지만 데이터베이스의 앵커 칸은 빈 채로 둔다. 회차마다 시작 상태가 달라지면 결과를
    나란히 읽을 수 없으므로, 검증이 이벤트에서 찾아낸 값으로 채워 맞춘다.
    """
    for _ in range(ANCHOR_WAIT_TRIES):
        anchor = (verify(usage_id) or {}).get("anchor") or {}
        if anchor.get("tx_hash"):
            _query(
                """
                UPDATE usage_history
                SET blockchain_tx_hash = %s, blockchain_block_number = %s,
                    blockchain_block_hash = %s, blockchain_transaction_index = %s
                WHERE usage_id = %s
                """,
                (
                    anchor["tx_hash"],
                    anchor.get("block_number"),
                    anchor.get("block_hash"),
                    anchor.get("transaction_index"),
                    usage_id,
                ),
                fetch=False,
            )
            return
        time.sleep(ANCHOR_WAIT_SEC)

    raise RuntimeError(f"이력 {usage_id}이 체인에 기록되지 않았다")


def _record_movement(nfc_token: str) -> None:
    """대여와 반납 사이에 구역 전환을 하나 남긴다.

    이동 경로는 그 구간의 위치 판정 이력을 묶어 만들어지므로, 곧바로 반납하면 빈 값이
    된다. 빈 값을 지우는 변조는 아무것도 바꾸지 못해 시나리오가 성립하지 않는다.
    """
    _query(
        """
        INSERT INTO tag_state_history (tag_id, reader_id, rssi, decided_at)
        SELECT t.tag_id, r.reader_id, -70, now()
        FROM tags t
        CROSS JOIN LATERAL (
            SELECT reader_id FROM readers
            WHERE reader_id <> COALESCE(
                (SELECT reader_id FROM tag_state_history WHERE tag_id = t.tag_id
                 ORDER BY decided_at DESC LIMIT 1), ''
            )
            ORDER BY reader_id LIMIT 1
        ) r
        WHERE t.nfc_token = %s
        """,
        (nfc_token,),
        fetch=False,
    )


def anchor_of(usage_id: int) -> dict:
    row = _query(
        "SELECT blockchain_tx_hash, blockchain_block_number, blockchain_block_hash, "
        "blockchain_transaction_index FROM usage_history WHERE usage_id = %s",
        (usage_id,),
    )[0]
    return {"tx_hash": row[0], "block_number": row[1], "block_hash": row[2], "tx_index": row[3]}


def verify(usage_id: int):
    """백엔드가 쓰는 검증을 그대로 부른다."""
    _limit, _offset, _total, rows = query_usage_history_rows(
        user=None,
        equipment=None,
        checkout_location=None,
        return_location=None,
        date=None,
        start_date=None,
        end_date=None,
        sort_by="time",
        sort_order="desc",
        limit=200,
        max_limit=200,
        offset=0,
        include_in_use=False,
    )
    target = [row for row in rows if row[0] == usage_id]
    if not target:
        raise RuntimeError(f"이력 {usage_id}을 조회 결과에서 찾지 못했다")
    results, _summary = verify_usage_history_integrity(target)
    return results.get(usage_id) or {}


def _as_param(value):
    """JSONB 컬럼은 dict/list로 읽히지만 쓸 때는 문자열이어야 한다."""
    return json.dumps(value) if isinstance(value, dict | list) else value


@contextlib.contextmanager
def tampered(usage_id: int, column: str, value):
    """한 컬럼을 바꿨다가 되돌린다. 다음 시나리오가 앞 시나리오의 잔재를 받지 않게 한다."""
    before = _query(f"SELECT {column} FROM usage_history WHERE usage_id = %s", (usage_id,))[0][0]
    _query(
        f"UPDATE usage_history SET {column} = %s WHERE usage_id = %s",
        (_as_param(value(before)), usage_id),
        fetch=False,
    )
    try:
        yield
    finally:
        _query(
            f"UPDATE usage_history SET {column} = %s WHERE usage_id = %s",
            (_as_param(before), usage_id),
            fetch=False,
        )


@contextlib.contextmanager
def hijacked_rpc(rules: list[rpc_proxy.Rule]):
    """검증이 체인에 묻는 답을 프록시가 바꾼다 — RPC 노드를 장악한 공격자."""
    with rpc_proxy.TamperingProxy(BESU_RPC_URL, rules) as proxy:
        previous = os.environ.get("BESU_RPC_URL")
        os.environ["BESU_RPC_URL"] = proxy.url
        try:
            yield proxy
        finally:
            if previous is None:
                os.environ.pop("BESU_RPC_URL", None)
            else:
                os.environ["BESU_RPC_URL"] = previous


# --- 시나리오 실행 -----------------------------------------------------------


def _result(scenario: Scenario, payload: dict, detail: str = "", run: int = 1) -> Result:
    status = payload.get("verification_status", "unknown")
    return Result(
        run=run,
        number=scenario.number,
        tier=scenario.tier,
        name=scenario.name,
        expected=scenario.expected,
        status=status,
        matched=matches_expectation(scenario, status),
        catches=scenario.catches,
        mismatch_fields=",".join(payload.get("mismatch_fields") or []),
        db_matches_onchain=payload.get("db_matches_onchain"),
        db_matches_event=payload.get("db_matches_event"),
        tx_input_matches_db=payload.get("tx_input_matches_db"),
        tx_sender_matches=payload.get("tx_sender_matches"),
        transactions_root_matches=payload.get("transactions_root_matches"),
        tx_included_in_block=payload.get("tx_included_in_block"),
        detail=detail or (payload.get("detail") or ""),
    )


def _run_rerecord(scenario: Scenario, usage_id: int, run: int) -> Result:
    """같은 식별자에 다른 원문을 기록하려 시도한다. 컨트랙트가 거절해야 한다."""
    record = fetch_usage_record_for_chain(usage_id)
    record = {**record, "checkoutLocation": "위조된 구역"}
    ok, stdout, stderr = run_besu_script("record-usage-record.mjs", stdin_payload=json.dumps(record))
    detail = (stderr or stdout or "").strip().splitlines()[-1] if (stderr or stdout) else ""
    return _result(scenario, {"verification_status": "rejected" if not ok else "accepted"}, detail[:160], run)


def _run_unanchored(scenario: Scenario, usage_id: int, run: int) -> Result:
    """체인 기록이 없는 완료 이력을 만든다 — 블록체인이 멈춘 동안 생긴 이력에 해당한다."""
    new_id = _query(
        """
        INSERT INTO usage_history (
            usage_status, user_id, user_name, user_position, user_department,
            returned_by_user_id, returned_by_name, returned_by_position, returned_by_department,
            tag_id, equipment_name, equipment_type, equipment_nfc_token,
            checkout_method, checkout_reader_id, checkout_location, checkout_at,
            return_method, return_reader_id, return_location, returned_at, movement_path
        )
        SELECT usage_status, user_id, user_name, user_position, user_department,
               returned_by_user_id, returned_by_name, returned_by_position, returned_by_department,
               tag_id, equipment_name, equipment_type, equipment_nfc_token,
               checkout_method, checkout_reader_id, checkout_location, checkout_at,
               return_method, return_reader_id, return_location, returned_at, movement_path
        FROM usage_history WHERE usage_id = %s
        RETURNING usage_id
        """,
        (usage_id,),
    )[0][0]
    try:
        return _result(scenario, verify(new_id), run=run)
    finally:
        _query("DELETE FROM usage_history WHERE usage_id = %s", (new_id,), fetch=False)


def run_scenario(scenario: Scenario, usage_id: int, run: int = 1) -> Result:
    if scenario.kind == "baseline":
        return _result(scenario, verify(usage_id), run=run)

    if scenario.kind in {"anchored", "display", "anchor_meta"}:
        with tampered(usage_id, scenario.column, scenario.value):
            return _result(scenario, verify(usage_id), run=run)

    if scenario.kind == "proxy":
        with hijacked_rpc(scenario.rules(anchor_of(usage_id))) as proxy:
            payload = verify(usage_id)
        return _result(scenario, payload, f"위조한 메서드: {','.join(sorted(set(proxy.tampered))) or '없음'}", run)

    if scenario.kind == "rerecord":
        return _run_rerecord(scenario, usage_id, run)

    if scenario.kind == "unanchored":
        return _run_unanchored(scenario, usage_id, run)

    raise RuntimeError(f"알 수 없는 시나리오 종류: {scenario.kind}")


def run(out_csv: Path, *, repeat: int = 1, progress=None) -> list[Result]:
    reserve_usage_id_range()

    results = []
    for index in range(repeat):
        # 회차마다 다른 장비와 직원을 써서, 한 이력에만 성립하는 우연을 걸러낸다.
        usage_id = create_anchored_usage(variant=index)
        for scenario in SCENARIOS:
            result = run_scenario(scenario, usage_id, run=index + 1)
            results.append(result)
            if progress:
                progress(result)

    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for result in results:
            writer.writerow(asdict(result))
    return results


def main(argv: list[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(prog="python -m eval.integrity", description="무결성 검증 평가")
    parser.add_argument("--out", type=Path, default=Path("eval/runs/latest/integrity.csv"))
    parser.add_argument(
        "--repeat",
        type=int,
        default=10,
        help="시나리오를 반복할 이력 수. 회차마다 다른 장비와 직원을 쓴다",
    )
    parser.add_argument(
        "--consensus",
        action="store_true",
        help="검증 노드를 실제로 내려 정족수 성질을 확인한다 (시나리오 14·15)",
    )
    args = parser.parse_args(argv)

    started = dt.datetime.now()

    def progress(result: Result) -> None:
        if result.number != SCENARIOS[0].number:
            return
        print(f"  {result.run}회차 — 시나리오 {len(SCENARIOS)}종", end="", flush=True)

    print(f"무결성 시나리오 {len(SCENARIOS)}종 × {args.repeat}건", flush=True)
    results = run(args.out, repeat=args.repeat, progress=progress)
    print()

    # 시나리오별로 몇 회차에서 기대와 일치했는지 모은다.
    for scenario in SCENARIOS:
        matching = [result for result in results if result.number == scenario.number]
        passed = sum(1 for result in matching if result.matched)
        statuses = sorted({result.status for result in matching})
        mark = "✓" if passed == len(matching) else "✗"
        print(
            f"  {mark} {scenario.number:>2} [{scenario.tier}] {scenario.name:<28} "
            f"{passed}/{len(matching)} · {','.join(statuses)}"
        )

    if args.consensus:
        from eval import consensus

        print("\n합의 내결함성 — 검증 노드를 실제로 내린다", flush=True)
        for case in consensus.run():
            mark = "✓" if case.matched else "✗"
            state = "기록 성공" if case.anchored else "기록 실패"
            print(
                f"  {mark} {case.number:>2} [D] {case.stopped}대 중단 · 남은 {case.quorum} · {state} · {case.detail}",
                flush=True,
            )

    passed = sum(1 for result in results if result.matched)
    elapsed = (dt.datetime.now() - started).total_seconds()
    print(f"\n결과: {args.out} · 기대와 일치 {passed}/{len(results)} · {elapsed:.0f}초")


if __name__ == "__main__":
    main()
