import datetime as dt
import json
import logging
import os
import re
import subprocess

import psycopg
from fastapi import HTTPException

try:
    from backend.settings import BESU_DEPLOYMENT_PATH, BESU_DIR, DATABASE_URL
except ModuleNotFoundError as exc:
    if not exc.name or not exc.name.startswith("backend"):
        raise
    from settings import BESU_DEPLOYMENT_PATH, BESU_DIR, DATABASE_URL

logger = logging.getLogger("mediledger.usage_history")


def is_besu_ready(*, require_signer: bool = False) -> tuple[bool, str | None]:
    if not BESU_DEPLOYMENT_PATH.exists():
        return False, "배포된 UsageRecordRegistry 컨트랙트 정보가 없습니다."
    if not (BESU_DIR / "node_modules").exists():
        return False, "blockchain/besu 의 npm 의존성이 설치되지 않았습니다."
    if require_signer:
        if not re.fullmatch(r"(?:0x)?[0-9A-Fa-f]{64}", os.getenv("BESU_SENDER_PRIVATE_KEY", "")):
            return False, "BESU_SENDER_PRIVATE_KEY가 설정되지 않았거나 형식이 잘못됐습니다."
        if not re.fullmatch(r"0x[0-9A-Fa-f]{40}", os.getenv("BESU_SENDER_ADDRESS", "")):
            return False, "BESU_SENDER_ADDRESS가 설정되지 않았거나 형식이 잘못됐습니다."
    return True, None


# 검증 스크립트 1회 호출이 감당할 이력 수. 100건에 약 6초라 30초 타임아웃 안에 넉넉히 들어간다.
VERIFY_BATCH_SIZE = 100


def run_besu_script(script_name: str, *args: str, stdin_payload: str | None = None) -> tuple[bool, str, str]:
    """JSON payload는 인자가 아니라 stdin으로 넘긴다.

    리눅스는 인자 하나의 길이를 MAX_ARG_STRLEN(128KB)으로 제한해서, 검증 대상이 많아지면
    exec 자체가 E2BIG로 실패한다. stdin에는 그런 상한이 없다.
    """
    try:
        process = subprocess.run(
            ["node", f"scripts/{script_name}", *args],
            cwd=BESU_DIR,
            env=os.environ.copy(),
            input=stdin_payload,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return False, "", "온체인 스크립트 실행이 타임아웃(30초)을 초과했습니다."
    except OSError as exc:
        return False, "", f"온체인 스크립트 실행에 실패했습니다: {exc}"
    return process.returncode == 0, process.stdout.strip(), process.stderr.strip()


def fetch_usage_record_for_chain(usage_id: int) -> dict | None:
    sql = """
    SELECT
      h.usage_id,
      h.user_id,
      h.returned_by_user_id,
      h.tag_id,
      h.checkout_location,
      EXTRACT(EPOCH FROM h.checkout_at)::BIGINT AS checkout_at_epoch,
      h.return_location,
      EXTRACT(EPOCH FROM h.returned_at)::BIGINT AS returned_at_epoch,
      h.movement_path
    FROM usage_history h
    WHERE h.usage_id = %s
      AND h.usage_status = 'returned'
    LIMIT 1
    """
    try:
        with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
            cur.execute(sql, (usage_id,))
            row = cur.fetchone()
    except Exception:
        raise HTTPException(500, "블록체인 기록용 사용 이력 조회 중 데이터베이스 오류가 발생했습니다.")

    if not row:
        return None

    return {
        "usageId": str(row[0]),
        "checkoutUserId": row[1],
        "returnUserId": row[2],
        "tagId": row[3] or "",
        "checkoutLocation": row[4] or "",
        "checkoutAt": row[5] or 0,
        "returnLocation": row[6] or "",
        "returnedAt": row[7] or 0,
        "movementPath": row[8] or [],
    }


def read_usage_record_from_chain(usage_id: int) -> dict:
    ready, reason = is_besu_ready()
    if not ready:
        return {
            "status": "not_configured",
            "detail": reason,
            "exists": False,
        }

    ok, stdout, stderr = run_besu_script("read-usage-record.mjs", str(usage_id))
    if not ok:
        return {
            "status": "read_error",
            "detail": stderr or stdout or "온체인 조회에 실패했습니다.",
            "exists": False,
        }

    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        return {
            "status": "read_error",
            "detail": "온체인 조회 응답을 해석하지 못했습니다.",
            "exists": False,
        }

    return {
        "status": "ok",
        "detail": None,
        "exists": bool(payload.get("exists")),
        "record": payload,
    }


def usage_record_matches_chain(expected: dict, actual: dict) -> bool:
    comparable_keys = (
        "usageId",
        "checkoutUserId",
        "returnUserId",
        "tagId",
        "checkoutLocation",
        "checkoutAt",
        "returnLocation",
        "returnedAt",
        "movementPath",
    )
    return all(expected.get(key) == actual.get(key) for key in comparable_keys)


def anchor_usage_record_to_chain(usage_id: int) -> dict:
    ready, reason = is_besu_ready(require_signer=True)
    if not ready:
        return {
            "ok": False,
            "status": "not_configured",
            "detail": reason,
        }

    payload = fetch_usage_record_for_chain(usage_id)
    if not payload:
        return {
            "ok": False,
            "status": "missing_usage",
            "detail": "반납 완료된 사용 이력을 찾을 수 없습니다.",
        }

    existing = read_usage_record_from_chain(usage_id)
    if existing["status"] == "ok" and existing["exists"]:
        onchain_record = existing.get("record") or {}
        if not usage_record_matches_chain(payload, onchain_record):
            return {
                "ok": False,
                "status": "mismatch",
                "detail": "이미 다른 원문 레코드가 온체인에 기록되어 있습니다.",
                "record": onchain_record,
            }
        return {
            "ok": True,
            "status": "already_anchored",
            "detail": None,
            "record": onchain_record,
        }

    ok, stdout, stderr = run_besu_script(
        "record-usage-record.mjs", stdin_payload=json.dumps(payload, ensure_ascii=False)
    )
    if not ok:
        return {
            "ok": False,
            "status": "record_error",
            "detail": stderr or stdout or "온체인 기록에 실패했습니다.",
        }

    try:
        result = json.loads(stdout)
    except json.JSONDecodeError:
        return {
            "ok": False,
            "status": "record_error",
            "detail": "온체인 기록 응답을 해석하지 못했습니다.",
        }

    return {
        "ok": True,
        "status": "anchored",
        "detail": None,
        "record": payload,
        "transaction_hash": result.get("txHash"),
        "block_number": result.get("blockNumber"),
        "block_hash": result.get("blockHash"),
        "transaction_index": result.get("transactionIndex"),
        "recorded_at": result.get("recordedAt"),
    }


def persist_usage_chain_anchor_metadata(usage_id: int, anchor_result: dict) -> None:
    tx_hash = anchor_result.get("transaction_hash")
    if not tx_hash:
        return

    block_number = anchor_result.get("block_number")
    block_hash = anchor_result.get("block_hash")
    transaction_index = anchor_result.get("transaction_index")
    recorded_at_epoch = anchor_result.get("recorded_at")
    recorded_at = dt.datetime.fromtimestamp(recorded_at_epoch, dt.UTC) if isinstance(recorded_at_epoch, int) else None

    sql = """
    UPDATE usage_history
    SET
      blockchain_tx_hash = %s,
      blockchain_block_number = %s,
      blockchain_block_hash = %s,
      blockchain_transaction_index = %s,
      blockchain_recorded_at = COALESCE(%s, blockchain_recorded_at),
      updated_at = now()
    WHERE usage_id = %s
    """
    try:
        with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
            cur.execute(
                sql,
                (
                    tx_hash,
                    block_number,
                    block_hash,
                    transaction_index,
                    recorded_at,
                    usage_id,
                ),
            )
            conn.commit()
    except Exception:
        logger.exception("체인 앵커링 메타데이터 저장 실패 (usage_id=%s)", usage_id)
        return


def build_usage_history_item(row, blockchain: dict | None = None) -> dict:
    return {
        "usage_id": row[0],
        "usage_status": row[1],
        "user": {
            "user_id": row[2],
            "name": row[3],
            "position": row[4],
            "department": row[5],
        },
        "returned_by": {
            "user_id": row[6],
            "name": row[7],
            "position": row[8],
            "department": row[9],
        },
        "equipment": {
            "tag_id": row[10],
            "name": row[11],
            "type": row[12],
            # 관리자 화면에서 모의 데이터를 숨길 수 있게 함께 내려준다.
            # tags 행이 지워진 옛 이력은 NULL이 되므로 실물로 간주한다.
            "is_real_hardware": True if row[25] is None else row[25],
        },
        "checkout": {
            "reader_id": row[13],
            "location": row[14],
            "at": row[15],
        },
        "return": {
            "reader_id": row[16],
            "location": row[17],
            "at": row[18],
        },
        "created_at": row[19],
        "movement_path": row[26] or [],
        "blockchain": blockchain,
    }


def build_usage_history_verification_request(row) -> dict:
    usage_id = row[0]
    usage_status = row[1]
    payload = {
        "usageId": str(usage_id),
        "usageStatus": usage_status,
        "expected": None,
        "anchor": {
            "txHash": row[20],
            "blockNumber": row[21],
            "blockHash": row[22],
            "transactionIndex": row[23],
            "recordedAt": row[24],
        },
    }

    if usage_status != "returned":
        return payload
    if row[2] is None or row[6] is None or row[15] is None or row[18] is None:
        return payload

    payload["expected"] = {
        "usageId": str(usage_id),
        "checkoutUserId": row[2],
        "returnUserId": row[6],
        "tagId": row[10] or "",
        "checkoutLocation": row[14] or "",
        "checkoutAt": row[15] or 0,
        "returnLocation": row[17] or "",
        "returnedAt": row[18] or 0,
        "movementPath": row[26] or [],
    }
    return payload


def build_default_integrity_result(*, usage_status: str, detail: str) -> dict:
    if usage_status != "returned":
        return {
            "verification_status": "not_eligible",
            "verification_label": "사용 중",
            "verification_method": "아직 반납되지 않아 사용 중인 이력이라 온체인 검증 대상이 아닙니다.",
            "detail": None,
            "eligible": False,
            "db_record": None,
            "onchain_record": None,
            "event_record": None,
            "onchain_exists": False,
            "db_matches_onchain": None,
            "db_matches_event": None,
            "tx_input_matches_db": None,
            "tx_included_in_block": None,
            "transactions_root_matches": None,
            "mismatch_fields": [],
            "anchor": {
                "source": None,
                "tx_hash": None,
                "block_number": None,
                "block_hash": None,
                "transaction_index": None,
                "recorded_at": None,
                "transactions_root": None,
                "recalculated_transactions_root": None,
            },
        }

    return {
        "verification_status": "not_configured",
        "verification_label": "체인 미설정",
        "verification_method": detail,
        "detail": detail,
        "eligible": True,
        "db_record": None,
        "onchain_record": None,
        "event_record": None,
        "onchain_exists": False,
        "db_matches_onchain": None,
        "db_matches_event": None,
        "tx_input_matches_db": None,
        "tx_included_in_block": None,
        "transactions_root_matches": None,
        "mismatch_fields": [],
        "anchor": {
            "source": None,
            "tx_hash": None,
            "block_number": None,
            "block_hash": None,
            "transaction_index": None,
            "recorded_at": None,
            "transactions_root": None,
            "recalculated_transactions_root": None,
        },
    }


def build_verification_failure_summary(rows, status: str) -> dict:
    returned = sum(1 for row in rows if row[1] == "returned")
    not_eligible = len(rows) - returned
    return {
        "total_count": len(rows),
        "eligible_count": returned,
        "verified_count": 0,
        "failed_count": returned,
        "not_eligible_count": not_eligible,
        "status_counts": {status: returned, "not_eligible": not_eligible},
    }


def merge_verification_summaries(summaries) -> dict:
    merged = {
        "total_count": 0,
        "eligible_count": 0,
        "verified_count": 0,
        "failed_count": 0,
        "not_eligible_count": 0,
    }
    status_counts: dict[str, int] = {}
    for summary in summaries:
        for key in merged:
            value = summary.get(key)
            if isinstance(value, int):
                merged[key] += value
        for status, count in (summary.get("status_counts") or {}).items():
            if isinstance(count, int):
                status_counts[status] = status_counts.get(status, 0) + count
    merged["status_counts"] = status_counts
    return merged


def verify_usage_history_batch(rows) -> tuple[dict[int, dict], dict]:
    """스크립트 한 번 호출로 처리하는 단위. 실패하면 이 배치만 저하된다."""
    requests = [build_usage_history_verification_request(row) for row in rows]
    ok, stdout, stderr = run_besu_script(
        "verify-usage-records.mjs",
        stdin_payload=json.dumps({"items": requests}, ensure_ascii=False, separators=(",", ":")),
    )
    if not ok:
        detail = stderr or stdout or "온체인 검증 스크립트 실행에 실패했습니다."
    else:
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            detail = "온체인 검증 응답을 해석하지 못했습니다."
        else:
            results = {
                int(item["usage_id"]): item
                for item in payload.get("items", [])
                if isinstance(item, dict) and str(item.get("usage_id", "")).isdigit()
            }
            for row in rows:
                results.setdefault(
                    row[0],
                    build_default_integrity_result(
                        usage_status=row[1],
                        detail="해당 이력의 온체인 검증 결과를 찾지 못했습니다.",
                    ),
                )
            return results, payload.get("summary") or {}

    fallback = {row[0]: build_default_integrity_result(usage_status=row[1], detail=detail) for row in rows}
    return fallback, build_verification_failure_summary(rows, "chain_error")


def verify_usage_history_integrity(rows) -> tuple[dict[int, dict], dict]:
    ready, reason = is_besu_ready()
    if not ready:
        default_results = {
            row[0]: build_default_integrity_result(
                usage_status=row[1],
                detail="온체인 검증 환경이 아직 준비되지 않았습니다.",
            )
            for row in rows
        }
        if reason:
            for row in rows:
                if row[1] == "returned":
                    default_results[row[0]]["verification_method"] = reason
                    default_results[row[0]]["detail"] = reason
        return default_results, build_verification_failure_summary(rows, "not_configured")

    results: dict[int, dict] = {}
    summaries = []
    for start in range(0, len(rows), VERIFY_BATCH_SIZE):
        batch = rows[start : start + VERIFY_BATCH_SIZE]
        batch_results, batch_summary = verify_usage_history_batch(batch)
        results.update(batch_results)
        summaries.append(batch_summary)
    return results, merge_verification_summaries(summaries)


def query_usage_history_rows(
    user: str | None,
    equipment: str | None,
    checkout_location: str | None,
    return_location: str | None,
    date: str | None,
    start_date: str | None,
    end_date: str | None,
    sort_by: str,
    sort_order: str,
    limit: int,
    max_limit: int,
    offset: int = 0,
    hide_simulated: bool = False,
    include_in_use: bool = True,
):
    """한 페이지 분량의 행과 조건에 맞는 전체 건수를 함께 돌려준다.

    반환: (safe_limit, safe_offset, total, rows)
    """
    safe_limit = max(1, min(limit, max_limit))
    safe_offset = max(0, offset)
    where_clauses = []
    params: list = []
    normalized_sort_by = (sort_by or "time").strip().lower()
    normalized_sort_order = (sort_order or "desc").strip().lower()

    sort_columns = {
        "time": "h.checkout_at",
        "user": "LOWER(h.user_name)",
        "equipment": "LOWER(h.equipment_name)",
    }
    if normalized_sort_by not in sort_columns:
        raise HTTPException(400, "sort_by는 time, user, equipment 중 하나여야 합니다.")
    if normalized_sort_order not in ("asc", "desc"):
        raise HTTPException(400, "sort_order는 asc 또는 desc 여야 합니다.")

    order_direction = "ASC" if normalized_sort_order == "asc" else "DESC"
    primary_sort_column = sort_columns[normalized_sort_by]
    order_sql = f"{primary_sort_column} {order_direction}, h.checkout_at DESC, h.usage_id DESC"

    if user and user.strip():
        q = f"%{user.strip()}%"
        where_clauses.append("(h.user_name ILIKE %s OR CAST(h.user_id AS TEXT) ILIKE %s)")
        params.extend([q, q])

    if equipment and equipment.strip():
        q = f"%{equipment.strip()}%"
        where_clauses.append("(h.equipment_name ILIKE %s OR h.tag_id ILIKE %s)")
        params.extend([q, q])

    if checkout_location and checkout_location.strip():
        where_clauses.append("COALESCE(h.checkout_location, h.checkout_reader_id, '') = %s")
        params.append(checkout_location.strip())

    if return_location and return_location.strip():
        where_clauses.append("COALESCE(h.return_location, h.return_reader_id, '') = %s")
        params.append(return_location.strip())

    if date and date.strip():
        try:
            target_date = dt.date.fromisoformat(date.strip())
        except ValueError:
            raise HTTPException(400, "date는 YYYY-MM-DD 형식이어야 합니다.")
        where_clauses.append("h.checkout_at::date = %s")
        params.append(target_date)
    else:
        parsed_start_date = None
        parsed_end_date = None
        if start_date and start_date.strip():
            try:
                parsed_start_date = dt.date.fromisoformat(start_date.strip())
            except ValueError:
                raise HTTPException(400, "start_date는 YYYY-MM-DD 형식이어야 합니다.")
            where_clauses.append("h.checkout_at::date >= %s")
            params.append(parsed_start_date)
        if end_date and end_date.strip():
            try:
                parsed_end_date = dt.date.fromisoformat(end_date.strip())
            except ValueError:
                raise HTTPException(400, "end_date는 YYYY-MM-DD 형식이어야 합니다.")
            where_clauses.append("h.checkout_at::date <= %s")
            params.append(parsed_end_date)
        if parsed_start_date and parsed_end_date and parsed_start_date > parsed_end_date:
            raise HTTPException(400, "start_date는 end_date보다 늦을 수 없습니다.")

    if hide_simulated:
        # tags 행이 지워진 옛 이력(NULL)은 실물로 간주해 남긴다.
        where_clauses.append("t.is_real_hardware IS NOT FALSE")

    if not include_in_use:
        where_clauses.append("h.usage_status = 'returned'")

    where_sql = ""
    if where_clauses:
        where_sql = "WHERE " + " AND ".join(where_clauses)

    sql = f"""
    SELECT
      h.usage_id,
      h.usage_status,
      h.user_id,
      h.user_name,
      h.user_position,
      h.user_department,
      h.returned_by_user_id,
      h.returned_by_name,
      h.returned_by_position,
      h.returned_by_department,
      h.tag_id,
      h.equipment_name,
      h.equipment_type,
      h.checkout_reader_id,
      h.checkout_location,
      EXTRACT(EPOCH FROM h.checkout_at)::BIGINT AS checkout_at_epoch,
      h.return_reader_id,
      h.return_location,
      EXTRACT(EPOCH FROM h.returned_at)::BIGINT AS returned_at_epoch,
      EXTRACT(EPOCH FROM h.created_at)::BIGINT AS created_at_epoch,
      h.blockchain_tx_hash,
      h.blockchain_block_number,
      h.blockchain_block_hash,
      h.blockchain_transaction_index,
      EXTRACT(EPOCH FROM h.blockchain_recorded_at)::BIGINT AS blockchain_recorded_at_epoch,
      -- 실물/모의 구분. 다른 자리 기반 row 인덱스를 밀지 않도록 반드시 맨 뒤에 둔다.
      t.is_real_hardware,
      h.movement_path
    FROM usage_history h
    LEFT JOIN tags t ON t.tag_id = h.tag_id
    {where_sql}
    ORDER BY {order_sql}
    LIMIT %s OFFSET %s
    """
    # 전체 건수는 페이지 수 계산에 필요하다. 조건은 같고 SELECT만 다르다.
    count_sql = f"""
    SELECT COUNT(*)
    FROM usage_history h
    LEFT JOIN tags t ON t.tag_id = h.tag_id
    {where_sql}
    """

    try:
        with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
            cur.execute(count_sql, params)
            total = cur.fetchone()[0]
            cur.execute(sql, [*params, safe_limit, safe_offset])
            rows = cur.fetchall()
    except Exception:
        raise HTTPException(500, "사용 이력 조회 중 데이터베이스 오류가 발생했습니다.")

    return safe_limit, safe_offset, total, rows


def query_my_usage_history_rows(user_id: int, limit: int):
    """특정 사용자가 직접 체크아웃한 사용 이력을 최신순으로 조회한다(검증/블록체인 없음).

    이름 substring 매칭은 부정확하므로 user_id 로 정확히 필터링한다.
    """
    safe_limit = max(1, min(limit, 200))
    sql = """
    SELECT
      h.usage_id,
      h.usage_status,
      h.equipment_name,
      h.equipment_type,
      h.checkout_location,
      h.checkout_reader_id,
      EXTRACT(EPOCH FROM h.checkout_at)::BIGINT AS checkout_at_epoch,
      h.return_location,
      h.return_reader_id,
      EXTRACT(EPOCH FROM h.returned_at)::BIGINT AS returned_at_epoch,
      h.movement_path
    FROM usage_history h
    WHERE h.user_id = %s
    ORDER BY h.checkout_at DESC, h.usage_id DESC
    LIMIT %s
    """
    try:
        with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
            cur.execute(sql, (user_id, safe_limit))
            return cur.fetchall()
    except Exception:
        raise HTTPException(500, "내 사용 이력 조회 중 데이터베이스 오류가 발생했습니다.")


def build_my_usage_history_item(row) -> dict:
    return {
        "usage_id": row[0],
        "usage_status": row[1],
        "equipment": {"name": row[2], "type": row[3]},
        "checkout": {"location": row[4] or row[5], "at": row[6]},
        "return": {"location": row[7] or row[8], "at": row[9]},
        "movement_path": row[10] or [],
    }
