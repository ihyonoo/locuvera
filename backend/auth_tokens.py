"""일회성 액션 토큰 저장/소비 유틸리티.

이메일 인증, 비밀번호 재설정, OAuth handoff/pending 흐름에서 사용하는 단기 토큰을
`auth_action_tokens` 테이블에 저장한다. 원문 토큰은 반환값(메일 링크/리다이렉트 URL)에만
존재하고, DB에는 SHA-256 해시만 보관한다.
"""

import datetime as dt
import hashlib
import json
import secrets

import psycopg
from psycopg.types.json import Jsonb

try:
    from backend.settings import DATABASE_URL
except ModuleNotFoundError as exc:
    if not exc.name or not exc.name.startswith("backend"):
        raise
    from settings import DATABASE_URL


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def create_action_token(
    *,
    purpose: str,
    ttl_sec: int,
    user_id: int | None = None,
    payload: dict | None = None,
) -> str:
    """랜덤 원문 토큰을 생성해 해시를 저장하고, 원문을 반환한다."""
    raw_token = secrets.token_urlsafe(32)
    token_hash = _hash_token(raw_token)
    expires_at = dt.datetime.now(dt.UTC) + dt.timedelta(seconds=ttl_sec)

    sql = """
    INSERT INTO auth_action_tokens (user_id, purpose, token_hash, payload, expires_at)
    VALUES (%s, %s, %s, %s, %s)
    """
    with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute(
            sql,
            (
                user_id,
                purpose,
                token_hash,
                Jsonb(payload) if payload is not None else None,
                expires_at,
            ),
        )
    return raw_token


def consume_action_token(raw_token: str, purpose: str, *, cursor=None) -> dict | None:
    """토큰을 검증하고 일회성으로 소비한다.

    유효하면 {token_id, user_id, payload} 를 반환하고, 만료/사용/불일치면 None.
    """
    if not raw_token:
        return None
    token_hash = _hash_token(raw_token)

    if cursor is None:
        with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
            return consume_action_token(raw_token, purpose, cursor=cur)

    # 만료되지 않고 아직 사용되지 않은 토큰만 원자적으로 소비한다.
    cursor.execute(
        """
            UPDATE auth_action_tokens
            SET used_at = NOW()
            WHERE token_hash = %s
              AND purpose = %s
              AND used_at IS NULL
              AND expires_at > NOW()
            RETURNING token_id, user_id, payload
            """,
        (token_hash, purpose),
    )
    row = cursor.fetchone()

    if not row:
        return None

    payload = row[2]
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = None

    return {"token_id": row[0], "user_id": row[1], "payload": payload}
