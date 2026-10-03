import base64
import binascii
import hashlib
import hmac
import json
import re
import time

import psycopg
from fastapi import HTTPException
from passlib.context import CryptContext

try:
    from backend.settings import AUTH_TOKEN_SECRET, AUTH_TOKEN_TTL_SEC, DATABASE_URL, USERNAME_PATTERN
except ModuleNotFoundError as exc:
    if not exc.name or not exc.name.startswith("backend"):
        raise
    from settings import AUTH_TOKEN_SECRET, AUTH_TOKEN_TTL_SEC, DATABASE_URL, USERNAME_PATTERN

pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")


def normalize_username(raw: str) -> str:
    username = raw.strip()
    if not username:
        raise HTTPException(400, "username은 비어 있을 수 없습니다.")
    if not USERNAME_PATTERN.fullmatch(username):
        raise HTTPException(400, "username은 3~50자의 영문, 숫자, '.', '_', '-'만 사용할 수 있습니다.")
    return username


def normalize_display_name(raw: str) -> str:
    display_name = raw.strip()
    if not display_name:
        raise HTTPException(400, "display_name은 비어 있을 수 없습니다.")
    if len(display_name) > 50:
        raise HTTPException(400, "display_name은 50자를 초과할 수 없습니다.")
    if re.match(r"^[\s\x00-\x1f\x7f]*[=+\-@]", display_name):
        raise HTTPException(400, "display_name은 수식으로 해석되는 문자로 시작할 수 없습니다.")
    return display_name


def normalize_optional_text(raw: str | None, field_name: str, max_len: int = 50) -> str | None:
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    if len(value) > max_len:
        raise HTTPException(400, f"{field_name}은 {max_len}자를 초과할 수 없습니다.")
    return value


EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_email(raw: str | None) -> str:
    if raw is None:
        raise HTTPException(400, "email은 비어 있을 수 없습니다.")
    email = raw.strip().lower()
    if not email:
        raise HTTPException(400, "email은 비어 있을 수 없습니다.")
    if len(email) > 254 or not EMAIL_PATTERN.fullmatch(email):
        raise HTTPException(400, "email 형식이 올바르지 않습니다.")
    return email


def validate_password(raw: str) -> str:
    if not raw:
        raise HTTPException(400, "password는 비어 있을 수 없습니다.")
    if len(raw) < 8:
        raise HTTPException(400, "password는 8자 이상이어야 합니다.")
    if len(raw) > 128:
        raise HTTPException(400, "password는 128자를 초과할 수 없습니다.")
    if not re.search(r"[A-Za-z]", raw):
        raise HTTPException(400, "password는 영문자를 1자 이상 포함해야 합니다.")
    if not re.search(r"[0-9]", raw):
        raise HTTPException(400, "password는 숫자를 1자 이상 포함해야 합니다.")
    if not re.search(r"[^A-Za-z0-9]", raw):
        raise HTTPException(400, "password는 특수문자를 1자 이상 포함해야 합니다.")
    return raw


def encode_token_segment(payload: bytes) -> str:
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def decode_token_segment(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def build_auth_token(*, user_id: int, token_version: int = 0) -> tuple[str, int]:
    issued_at = int(time.time())
    expires_at = issued_at + AUTH_TOKEN_TTL_SEC
    payload = {
        "sub": user_id,
        "tv": token_version,
        "iat": issued_at,
        "exp": expires_at,
    }
    payload_segment = encode_token_segment(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(
        AUTH_TOKEN_SECRET.encode("utf-8"),
        payload_segment.encode("ascii"),
        hashlib.sha256,
    ).digest()
    token = f"{payload_segment}.{encode_token_segment(signature)}"
    return token, expires_at


def decode_auth_token(token: str) -> dict:
    try:
        payload_segment, signature_segment = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(401, "인증 토큰 형식이 올바르지 않습니다.") from exc

    try:
        expected_signature = hmac.new(
            AUTH_TOKEN_SECRET.encode("utf-8"),
            payload_segment.encode("ascii"),
            hashlib.sha256,
        ).digest()
        actual_signature = decode_token_segment(signature_segment)
    except (UnicodeError, ValueError, binascii.Error) as exc:
        raise HTTPException(401, "인증 토큰 형식이 올바르지 않습니다.") from exc
    if not hmac.compare_digest(expected_signature, actual_signature):
        raise HTTPException(401, "인증 토큰 검증에 실패했습니다.")

    try:
        payload = json.loads(decode_token_segment(payload_segment))
    except Exception as exc:
        raise HTTPException(401, "인증 토큰을 해석하지 못했습니다.") from exc

    if not isinstance(payload, dict):
        raise HTTPException(401, "인증 토큰 내용이 올바르지 않습니다.")

    user_id = payload.get("sub")
    expires_at = payload.get("exp")
    if not isinstance(user_id, int) or user_id <= 0:
        raise HTTPException(401, "인증 토큰의 사용자 정보가 올바르지 않습니다.")
    if not isinstance(expires_at, int):
        raise HTTPException(401, "인증 토큰의 만료 정보가 올바르지 않습니다.")
    if expires_at <= int(time.time()):
        raise HTTPException(401, "인증 토큰이 만료되었습니다.")

    return payload


def build_user_payload(row, *, can_manage_nfc: bool = False) -> dict:
    # row 컬럼 순서 계약: user_id, username, display_name, role, department, position, email, email_verified
    return {
        "user_id": row[0],
        "username": row[1],
        "display_name": row[2],
        "role": row[3],
        "department": row[4],
        "position": row[5],
        "email": row[6],
        "email_verified": row[7],
        "can_manage_nfc": bool(can_manage_nfc),
    }


def fetch_user_by_id(user_id: int):
    sql = """
    SELECT user_id, username, display_name, role, department, position,
           email, email_verified, is_active, token_version, is_demo, can_manage_nfc
    FROM users
    WHERE user_id = %s
    LIMIT 1
    """
    try:
        with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
            cur.execute(sql, (user_id,))
            return cur.fetchone()
    except Exception:
        raise HTTPException(500, "사용자 인증 처리 중 데이터베이스 오류가 발생했습니다.")


def require_authenticated_user(
    authorization: str | None,
    *,
    allowed_roles: set[str] | None = None,
) -> dict:
    if not authorization:
        raise HTTPException(401, "인증이 필요합니다.")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "Bearer 인증 토큰이 필요합니다.")

    payload = decode_auth_token(token.strip())
    row = fetch_user_by_id(payload["sub"])
    if not row:
        raise HTTPException(401, "존재하지 않는 사용자입니다.")
    # row[8]=is_active, row[9]=token_version (fetch_user_by_id 컬럼 순서 기준)
    if not row[8]:
        raise HTTPException(403, "비활성화된 계정입니다.")
    if int(payload.get("tv", 0)) != int(row[9]):
        raise HTTPException(401, "인증 토큰이 더 이상 유효하지 않습니다. 다시 로그인해 주세요.")

    user = build_user_payload(row, can_manage_nfc=row[11])
    # row[10]=is_demo (fetch_user_by_id 컬럼 순서 기준) — 데모 계정 가드가 이 값을 본다.
    user["is_demo"] = bool(row[10])
    role = str(user["role"]).lower()
    if allowed_roles and role not in allowed_roles:
        raise HTTPException(403, "이 작업을 수행할 권한이 없습니다.")
    return user
