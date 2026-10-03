import hashlib
import hmac
import re
import time

import psycopg
from fastapi import HTTPException, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

try:
    from backend.rtls_utils import get_redis_client
    from backend.schemas import Payload
    from backend.settings import DATABASE_URL, RTLS_REAL_READER_KEYS, RTLS_SIM_KEY
except ModuleNotFoundError as exc:
    if not exc.name or not exc.name.startswith("backend"):
        raise
    from rtls_utils import get_redis_client
    from schemas import Payload
    from settings import DATABASE_URL, RTLS_REAL_READER_KEYS, RTLS_SIM_KEY


MAX_BODY_BYTES = 64 * 1024
MAX_OBSERVATIONS = 256
NONCE_PATTERN = re.compile(r"[0-9a-f]{32}")
SIGNATURE_PATTERN = re.compile(r"[0-9a-f]{64}")
REPLAY_AND_RATE_SCRIPT = """
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], 2) end
if count > 5 then return -1 end
redis.call('SET', KEYS[1], '1', 'EX', 120)
return 1
"""


def _reader_key(reader_id: str) -> bytes:
    try:
        with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
            cur.execute("SELECT is_active, is_real_hardware FROM readers WHERE reader_id = %s", (reader_id,))
            row = cur.fetchone()
    except Exception as exc:
        raise HTTPException(503, "리더 등록 상태를 확인하지 못했습니다.") from exc
    if not row or not row[0]:
        raise HTTPException(403, "등록된 활성 리더가 아닙니다.")
    if row[1]:
        raw_key = RTLS_REAL_READER_KEYS.get(reader_id)
        if not isinstance(raw_key, str) or not raw_key:
            raise HTTPException(503, "리더 인증 정보가 설정되지 않았습니다.")
        return raw_key.encode("utf-8")
    if not RTLS_SIM_KEY:
        raise HTTPException(503, "시뮬레이터 인증 정보가 설정되지 않았습니다.")
    return hmac.new(RTLS_SIM_KEY.encode("utf-8"), f"rtls-sim-v1:{reader_id}".encode("ascii"), hashlib.sha256).digest()


def _reserve_nonce(reader_id: str, nonce: str, now: int):
    client = get_redis_client()
    if client is None:
        raise HTTPException(503, "리더 재전송 방지 저장소에 연결하지 못했습니다.")
    try:
        return client.eval(
            REPLAY_AND_RATE_SCRIPT, 2, f"rtls:auth:nonce:{reader_id}:{nonce}", f"rtls:auth:rate:{reader_id}:{now}"
        )
    except Exception as exc:
        raise HTTPException(503, "리더 재전송 방지 저장소에 연결하지 못했습니다.") from exc


async def authenticated_ingest_payload(request: Request) -> Payload:
    chunks = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise HTTPException(413, "리더 요청 본문이 너무 큽니다.")
        chunks.append(chunk)
    body = b"".join(chunks)
    reader_id = request.headers.get("X-RTLS-Reader-ID", "")
    timestamp = request.headers.get("X-RTLS-Timestamp", "")
    nonce = request.headers.get("X-RTLS-Nonce", "")
    signature = request.headers.get("X-RTLS-Signature", "")
    if (
        not re.fullmatch(r"M[0-9]{3}", reader_id)
        or not re.fullmatch(r"[0-9]{1,12}", timestamp)
        or not NONCE_PATTERN.fullmatch(nonce)
        or not SIGNATURE_PATTERN.fullmatch(signature)
    ):
        raise HTTPException(401, "리더 인증 정보가 올바르지 않습니다.")
    now = int(time.time())
    if abs(now - int(timestamp)) > 60:
        raise HTTPException(401, "리더 요청 시각이 유효하지 않습니다.")
    key = await run_in_threadpool(_reader_key, reader_id)
    message = f"v1\n{reader_id}\n{timestamp}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode("ascii")
    expected = hmac.new(key, message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(401, "리더 서명이 올바르지 않습니다.")
    try:
        payload = Payload.model_validate_json(body)
    except ValidationError as exc:
        raise HTTPException(422, "리더 요청 본문이 올바르지 않습니다.") from exc
    if payload.reader_id != reader_id:
        raise HTTPException(401, "리더 ID가 서명과 일치하지 않습니다.")
    if len(payload.observations) > MAX_OBSERVATIONS:
        raise HTTPException(413, "관측 수가 제한을 초과했습니다.")
    outcome = await run_in_threadpool(_reserve_nonce, reader_id, nonce, now)
    if outcome == 0:
        raise HTTPException(401, "이미 처리한 리더 요청입니다.")
    if outcome == -1:
        raise HTTPException(429, "리더 요청 빈도가 제한을 초과했습니다.")
    return payload
