import hashlib
import json

from fastapi import HTTPException

try:
    from backend.settings import (
        BLOCKCHAIN_DEMO_BLOCKS_PATH,
        BLOCKCHAIN_DEMO_FAILED_BLOCK_INDEX,
        BLOCKCHAIN_DEMO_FAILED_TRANSACTION_INDEX,
    )
except ModuleNotFoundError as exc:
    if not exc.name or not exc.name.startswith("backend"):
        raise
    from settings import (
        BLOCKCHAIN_DEMO_BLOCKS_PATH,
        BLOCKCHAIN_DEMO_FAILED_BLOCK_INDEX,
        BLOCKCHAIN_DEMO_FAILED_TRANSACTION_INDEX,
    )

BLOCKCHAIN_DEMO_USER_SPECS = [
    (2407714, "윤태성", "응급실", "응급의학과 전문의"),
    (2409126, "김민서", "응급실", "간호사"),
    (2410837, "박지훈", "응급실", "간호사"),
    (2411942, "이수연", "중환자실", "간호사"),
    (2412875, "정현우", "중환자실", "간호사"),
    (2413768, "최도윤", "수술실", "수술실 간호사"),
    (2414589, "한서준", "수술실", "마취간호사"),
    (2415524, "오지은", "회복실", "회복실 간호사"),
    (2416640, "강민재", "수술실", "순환간호사"),
    (2417386, "신유진", "중환자실", "책임간호사"),
    (2419054, "조현서", "응급실", "응급구조사"),
    (2420186, "김도연", "7병동", "간호사"),
    (2421463, "이준호", "8병동", "간호사"),
    (2423018, "송하린", "영상의학과", "방사선사"),
    (2424871, "임지후", "영상의학과", "방사선사"),
    (2425210, "배수진", "7병동", "간호사"),
    (2426127, "서민아", "내시경실", "간호사"),
    (2426624, "장유리", "8병동", "간호사"),
    (2426841, "노현지", "7병동", "간호사"),
    (2427442, "문태경", "8병동", "간호사"),
    (2427745, "백나영", "내시경실", "간호사"),
    (2428814, "황지성", "검사실", "임상병리사"),
    (2429283, "구서영", "영상의학과", "방사선사"),
    (2429540, "안채원", "내시경실", "간호사"),
    (2430156, "류민호", "검사실", "임상병리사"),
    (2431184, "남지훈", "검사실", "임상병리사"),
    (2432061, "고은별", "회복실", "간호사"),
    (2434097, "최은석", "중환자실", "호흡치료사"),
    (2436448, "진서현", "격리병실", "간호사"),
    (2437091, "손예준", "격리병실", "간호사"),
]

BLOCKCHAIN_DEMO_USERS = {
    user_id: {
        "user_id": user_id,
        "name": display_name,
        "department": department,
        "position": position,
    }
    for user_id, display_name, department, position in BLOCKCHAIN_DEMO_USER_SPECS
}

BLOCKCHAIN_DEMO_EQUIPMENT_SPECS = [
    ("FAC-20-008741", "응급 이송 스트레처", "이송장비"),
    ("FAC-21-014582", "병동 이송 스트레처", "이송장비"),
    ("FAC-20-008745", "접이식 휠체어", "이동보조"),
    ("FAC-21-014583", "병동 휠체어", "이동보조"),
    ("BME-24-003117", "제세동기", "응급장비"),
    ("BME-24-003118", "제세동기", "응급장비"),
    ("BME-24-002418", "이동형 인공호흡기", "호흡장비"),
    ("BME-24-002419", "이동형 인공호흡기", "호흡장비"),
    ("BME-24-008531", "인퓨전 펌프", "주입장비"),
    ("BME-24-008533", "인퓨전 펌프", "주입장비"),
    ("BME-23-001984", "환자감시장치", "모니터링"),
    ("BME-23-001985", "환자감시장치", "모니터링"),
    ("BME-23-009144", "흡인기", "처치장비"),
    ("BME-23-009145", "흡인기", "처치장비"),
    ("BME-22-006207", "산소포화도 측정기", "모니터링"),
    ("BME-22-006208", "네뷸라이저", "호흡장비"),
    ("BME-22-004263", "심전도기", "진단장비"),
    ("BME-22-004264", "심전도기", "진단장비"),
    ("BME-21-011506", "네뷸라이저", "호흡장비"),
    ("BME-21-011507", "네뷸라이저", "호흡장비"),
]

BLOCKCHAIN_DEMO_EQUIPMENT = {
    tag_id: {
        "tag_id": tag_id,
        "name": equipment_name,
        "type": equipment_type,
    }
    for tag_id, equipment_name, equipment_type in BLOCKCHAIN_DEMO_EQUIPMENT_SPECS
}


def parse_demo_int(value) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def get_demo_user_profile(user_id: int | None) -> dict:
    if user_id is None:
        return {
            "user_id": None,
            "name": "-",
            "department": "-",
            "position": "-",
        }

    profile = BLOCKCHAIN_DEMO_USERS.get(user_id)
    if profile:
        return dict(profile)

    return {
        "user_id": user_id,
        "name": f"직원 {user_id}",
        "department": "-",
        "position": "-",
    }


def get_demo_equipment_profile(tag_id: str | None) -> dict:
    if not tag_id:
        return {
            "tag_id": "-",
            "name": "미상 장비",
            "type": None,
        }

    profile = BLOCKCHAIN_DEMO_EQUIPMENT.get(tag_id)
    if profile:
        return dict(profile)

    return {
        "tag_id": tag_id,
        "name": tag_id,
        "type": None,
    }


def build_demo_recalculated_merkle_root(recorded_merkle_root: str | None, should_fail: bool) -> str | None:
    if not recorded_merkle_root:
        return None
    if not should_fail:
        return recorded_merkle_root
    digest = hashlib.sha256(f"{recorded_merkle_root}:tampered-merkle-root".encode()).hexdigest()
    return f"0x{digest}"


def load_blockchain_demo_history_payload() -> dict:
    if not BLOCKCHAIN_DEMO_BLOCKS_PATH.exists():
        raise HTTPException(500, "블록체인 데모 데이터 파일이 존재하지 않습니다.")

    try:
        payload = json.loads(BLOCKCHAIN_DEMO_BLOCKS_PATH.read_text(encoding="utf-8"))
    except Exception:
        raise HTTPException(500, "블록체인 데모 데이터 파일을 읽는 중 오류가 발생했습니다.")

    if not isinstance(payload, dict) or not isinstance(payload.get("blocks"), list):
        raise HTTPException(500, "블록체인 데모 데이터 형식이 올바르지 않습니다.")

    return payload


def build_blockchain_demo_history() -> dict:
    payload = load_blockchain_demo_history_payload()
    blocks = []
    items = []

    for block in payload["blocks"]:
        header = block.get("header", {})
        transactions = block.get("body", {}).get("transactions", [])
        block_batch_index = parse_demo_int(block.get("batchIndex")) or 0
        block_number = parse_demo_int(header.get("number")) or 0
        block_hash = header.get("hash")
        block_timestamp = header.get("timestamp", {})
        transactions_root = header.get("transactionsRoot")
        receipts_root = header.get("receiptsRoot")
        state_root = header.get("stateRoot")
        transaction_count = parse_demo_int(header.get("transactionCount")) or len(transactions)

        blocks.append(
            {
                "batch_index": block_batch_index,
                "block_number": block_number,
                "block_hash": block_hash,
                "transaction_count": transaction_count,
                "timestamp": block_timestamp,
                "transactions_root": transactions_root,
                "receipts_root": receipts_root,
                "state_root": state_root,
            }
        )

        for tx in transactions:
            args = tx.get("input", {}).get("args", {})
            usage_id = str(args.get("usageId") or "")
            checkout_user_id = parse_demo_int(args.get("checkoutUserId"))
            return_user_id = parse_demo_int(args.get("returnUserId"))
            tag_id = args.get("tagId")
            checkout_location = args.get("checkoutLocation")
            return_location = args.get("returnLocation")
            checkout_at = parse_demo_int(args.get("checkoutAt"))
            returned_at = parse_demo_int(args.get("returnedAt"))
            transaction_index = parse_demo_int(tx.get("transactionIndex")) or 0
            is_failed_demo_record = (
                block_batch_index == BLOCKCHAIN_DEMO_FAILED_BLOCK_INDEX
                and transaction_index == BLOCKCHAIN_DEMO_FAILED_TRANSACTION_INDEX
            )
            recalculated_merkle_root = build_demo_recalculated_merkle_root(
                transactions_root,
                is_failed_demo_record,
            )
            is_verified_demo_record = (
                transactions_root is not None
                and recalculated_merkle_root is not None
                and transactions_root == recalculated_merkle_root
            )
            verification_method = (
                "블록 헤더의 머클 루트(transactionsRoot)와 트랜잭션 인덱스 포함 정보 일치"
                if is_verified_demo_record
                else "블록 헤더의 머클 루트(transactionsRoot)와 트랜잭션 인덱스 포함 정보 불일치"
            )

            items.append(
                {
                    "usage_id": usage_id,
                    "user": get_demo_user_profile(checkout_user_id),
                    "returned_by": get_demo_user_profile(return_user_id),
                    "equipment": get_demo_equipment_profile(tag_id),
                    "checkout": {
                        "reader_id": None,
                        "location": checkout_location,
                        "at": checkout_at,
                    },
                    "return": {
                        "reader_id": None,
                        "location": return_location,
                        "at": returned_at,
                    },
                    "created_at": block_timestamp.get("epoch"),
                    "blockchain": {
                        "verification_status": "verified" if is_verified_demo_record else "failed",
                        "verification_label": "무결성 검증 성공" if is_verified_demo_record else "무결성 검증 실패",
                        "verification_method": verification_method,
                        "block_batch_index": block_batch_index,
                        "block_number": block_number,
                        "block_hash": block_hash,
                        "transaction_index": transaction_index,
                        "transaction_hash": tx.get("hash"),
                        "transactions_root": transactions_root,
                        "recorded_merkle_root": transactions_root,
                        "recalculated_merkle_root": recalculated_merkle_root,
                        "receipts_root": receipts_root,
                        "state_root": state_root,
                        "recorded_at": block_timestamp.get("epoch"),
                    },
                }
            )

    items.sort(
        key=lambda item: (
            item["blockchain"]["block_number"],
            item["blockchain"]["transaction_index"],
        )
    )
    verified_count = sum(1 for item in items if item["blockchain"]["verification_status"] == "verified")

    return {
        "ok": True,
        "count": len(items),
        "blocks": blocks,
        "items": items,
        "integrity_summary": {
            "verified_count": verified_count,
            "block_count": len(blocks),
            "transaction_count": len(items),
        },
    }
