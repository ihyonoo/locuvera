import contextlib
import os

# backend/settings.py가 import 시점에 DATABASE_URL·REDIS_URL을 읽으므로, backend 하위
# 모듈을 import하기 전에 반드시 먼저 테스트용 값으로 덮어써야 한다.
# (settings.py의 load_dotenv는 override=False라 여기서 넣은 값이 .env보다 우선한다)
os.environ["DATABASE_URL"] = "postgresql://mediledger:mediledger@localhost:5432/mediledger_test_db"
# Redis도 개발용(…/0)과 논리 DB를 나눈다. 같은 머신에서 개발 백엔드나 시뮬레이터가 돌면
# 그들이 쓴 rtls:tag:* 캐시를 테스트가 함께 읽어, TRUNCATE로 비운 tags와 어긋난 태그가
# /rtls/live 응답에 섞였다. 매 테스트 전 캐시를 지워도 시뮬레이터가 곧바로 다시 채운다.
os.environ["REDIS_URL"] = "redis://127.0.0.1:6379/1"
# NTAG 마스터키도 settings.py가 import 시점에 읽는다. 실물 태그 검증이 걸린 테스트가
# .env의 유무에 따라 통과하다 말다 하지 않도록 여기서 고정한다.
os.environ["NTAG_MASTER_KEY"] = "000102030405060708090A0B0C0D0E0F"
os.environ["RTLS_REAL_READER_KEYS"] = (
    '{"M501":"test-reader-key-32-bytes-000001",'
    '"M503":"test-reader-key-32-bytes-000003",'
    '"M504":"test-reader-key-32-bytes-000004"}'
)
os.environ["RTLS_SIM_KEY"] = "test-simulation-master-key-000001"

import hashlib
import hmac
import json
import secrets
import time

import psycopg
import pytest
from cryptography.hazmat.primitives.ciphers import algorithms
from cryptography.hazmat.primitives.cmac import CMAC
from fastapi.testclient import TestClient

from backend.auth_utils import build_auth_token, pwd
from backend.ntag424 import derive_sdm_session_mac_key, derive_tag_key
from backend.rtls_utils import REDIS_LOCATION_KEY_PREFIX, get_redis_client
from backend.server import app, tag_obs, tag_state

TEST_DATABASE_URL = os.environ["DATABASE_URL"]
TEST_NTAG_MASTER_KEY = bytes.fromhex(os.environ["NTAG_MASTER_KEY"])

# FK 의존 관계 상 어느 순서로 나열해도 무방하다(한 TRUNCATE 문 + CASCADE로 처리).
TABLES_TO_TRUNCATE = [
    "nfc_tap_sessions",
    "usage_nfc_events",
    "usage_history",
    "tag_state_history",
    "auth_action_tokens",
    "user_oauth_identities",
    "tags",
    "readers",
    "users",
]


def _flush_location_cache():
    """rtls:tag:* 캐시를 지운다.

    Redis는 이 프로세스 밖에 있는 공용 인스턴스라 DB TRUNCATE로는 안 지워진다.
    이전 테스트(예: test_ingest_flow.py)가 캐싱한 태그 위치가 남아 있으면, 다른
    테스트 파일이 TRUNCATE로 비운 readers/tags와 불일치해 FK 위반 등으로 깨질 수 있다.
    """
    client = get_redis_client()
    if client is None:
        return
    with contextlib.suppress(Exception):
        keys = list(client.scan_iter(match=f"{REDIS_LOCATION_KEY_PREFIX}*"))
        keys += list(client.scan_iter(match="rtls:auth:*"))
        if keys:
            client.delete(*keys)


@pytest.fixture(autouse=True)
def _clean_state():
    """매 테스트 전, DB 테이블·Redis 캐시·서버 메모리 상태(tag_obs/tag_state)를 초기화한다."""
    tag_obs.clear()
    tag_state.clear()
    _flush_location_cache()
    with psycopg.connect(TEST_DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute(f"TRUNCATE {', '.join(TABLES_TO_TRUNCATE)} RESTART IDENTITY CASCADE")
    yield


@pytest.fixture
def db_conn():
    with psycopg.connect(TEST_DATABASE_URL) as conn:
        yield conn


@pytest.fixture
def client():
    return TestClient(app)


def post_signed_ingest(client, payload):
    reader_id = payload["reader_id"]
    with psycopg.connect(TEST_DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute("SELECT is_real_hardware FROM readers WHERE reader_id = %s", (reader_id,))
        row = cur.fetchone()
    if row is None:
        raise AssertionError(f"리더를 먼저 등록해야 합니다: {reader_id}")
    if row[0]:
        key = json.loads(os.environ["RTLS_REAL_READER_KEYS"])[reader_id].encode()
    else:
        key = hmac.new(
            os.environ["RTLS_SIM_KEY"].encode(), f"rtls-sim-v1:{reader_id}".encode(), hashlib.sha256
        ).digest()
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    message = f"v1\n{reader_id}\n{timestamp}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode()
    signature = hmac.new(key, message, hashlib.sha256).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "X-RTLS-Reader-ID": reader_id,
        "X-RTLS-Timestamp": timestamp,
        "X-RTLS-Nonce": nonce,
        "X-RTLS-Signature": signature,
    }
    return client.post("/ingest", content=body, headers=headers)


@pytest.fixture
def seed_tag(db_conn):
    """/ingest, /where, /usage/checkout·return 같은 통합 테스트용 태그를 하나 만들어준다."""

    def _seed(
        tag_id: str = "EQ-TEST-0001",
        equipment_name: str = "테스트 장비",
        nfc_token: str | None = None,
        is_real_hardware: bool = True,
    ):
        with db_conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO tags (tag_id, equipment_name, nfc_token, is_active, is_real_hardware)
                VALUES (%s, %s, %s, TRUE, %s)
                """,
                (tag_id, equipment_name, nfc_token, is_real_hardware),
            )
        db_conn.commit()
        return tag_id

    return _seed


@pytest.fixture
def seed_reader(db_conn):
    """관리자 핀 편집기·rtls/live 통합 테스트용 리더를 하나 만들어준다."""

    def _seed(
        reader_id: str = "M999",
        location_name: str | None = "테스트 리더",
        is_real_hardware: bool = True,
    ):
        with db_conn.cursor() as cur:
            cur.execute(
                "INSERT INTO readers (reader_id, location_name, is_real_hardware) VALUES (%s, %s, %s)",
                (reader_id, location_name, is_real_hardware),
            )
        db_conn.commit()
        return reader_id

    return _seed


@pytest.fixture
def seed_user(db_conn):
    """인증이 필요한 통합 테스트용 사용자를 만들고 (user_id, Bearer 헤더)를 반환한다."""

    def _seed(
        username: str = "tester",
        role: str = "staff",
        is_active: bool = True,
        email_verified: bool = True,
        position: str | None = "간호사",
        password: str | None = None,
        email: str | None = None,
        is_demo: bool = False,
        can_manage_nfc: bool = False,
    ):
        password_hash = pwd.hash(password) if password else "x"
        with db_conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (username, display_name, role, position, password_hash,
                                    is_active, email_verified, token_version, email, is_demo, can_manage_nfc)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s)
                RETURNING user_id
                """,
                (
                    username,
                    username,
                    role,
                    position,
                    password_hash,
                    is_active,
                    email_verified,
                    email,
                    is_demo,
                    can_manage_nfc,
                ),
            )
            user_id = cur.fetchone()[0]
        db_conn.commit()
        token, _ = build_auth_token(user_id=user_id, token_version=0)
        return user_id, {"Authorization": f"Bearer {token}"}

    return _seed


def _uid_for(tag_id: str) -> str:
    """tag_id에서 결정론적으로 14자리 hex UID를 만든다 — 테스트끼리 UID가 겹치지 않게."""
    return hashlib.sha256(tag_id.encode()).hexdigest()[:14].upper()


def make_sdm_query(ntag_uid: str, read_ctr: int, master_key: bytes = TEST_NTAG_MASTER_KEY) -> dict:
    """실물 태그가 탭 순간 계산해 내보내는 쿼리스트링을 그대로 흉내낸다.

    서버의 검증 함수를 재사용하지만, 이 방향(서명)은 프로덕션에 없는 경로다 —
    알고리즘 자체는 tests/unit/test_ntag424.py가 NXP 공식 벡터로 따로 못박고 있다.
    """
    uid = bytes.fromhex(ntag_uid)
    session_key = derive_sdm_session_mac_key(derive_tag_key(master_key, uid), uid, read_ctr)
    ctx = CMAC(algorithms.AES(session_key))
    ctx.update(b"")
    return {"uid": ntag_uid, "ctr": f"{read_ctr:06X}", "cmac": ctx.finalize()[1::2].hex().upper()}


@pytest.fixture
def bind_ntag(db_conn):
    """장비 토큰에 NTAG UID를 바인딩하고 그 UID를 돌려준다."""

    def _bind(nfc_token: str, ntag_uid: str | None = None):
        with db_conn.cursor() as cur:
            cur.execute("SELECT tag_id FROM tags WHERE nfc_token = %s", (nfc_token,))
            row = cur.fetchone()
            assert row is not None, f"바인딩할 태그가 없다: {nfc_token}"
            uid = ntag_uid or _uid_for(row[0])
            cur.execute("UPDATE tags SET ntag_uid = %s, ntag_bound = TRUE WHERE tag_id = %s", (uid, row[0]))
        db_conn.commit()
        return uid

    return _bind


@pytest.fixture
def tap_session(client, db_conn, bind_ntag):
    """실물 태그를 한 번 탭한 것처럼 탭 세션을 발급받는다.

    아직 바인딩 안 된 태그면 즉석에서 바인딩하고, 카운터는 현재 값 + 1을 쓴다.
    대여/반납 테스트가 SDM 세부를 몰라도 실제 사용자 경로를 그대로 통과하게 하는 게 목적이다.
    """

    def _session(nfc_token: str, headers: dict) -> str:
        with db_conn.cursor() as cur:
            cur.execute(
                "SELECT ntag_uid, ntag_bound, ntag_last_ctr FROM tags WHERE nfc_token = %s",
                (nfc_token,),
            )
            uid, bound, last_ctr = cur.fetchone()
        db_conn.commit()  # 서버가 별도 연결로 갱신한 카운터를 다음 호출에서 다시 읽어야 한다
        if not bound:
            uid = bind_ntag(nfc_token)
            last_ctr = 0
        response = client.get(f"/nfc/{nfc_token}", params=make_sdm_query(uid, last_ctr + 1), headers=headers)
        assert response.status_code == 200, response.text
        return response.json()["tap_session"]

    return _session


def _is_real_hardware(db_conn, nfc_token: str) -> bool:
    with db_conn.cursor() as cur:
        cur.execute("SELECT is_real_hardware FROM tags WHERE nfc_token = %s", (nfc_token,))
        row = cur.fetchone()
    db_conn.commit()
    return bool(row and row[0])


@pytest.fixture
def checkout(client, db_conn, tap_session):
    """대여를 실제 사용자 경로로 수행한다.

    실물 태그면 탭 세션을 발급받아 붙이고, 시뮬레이션 태그면 지금까지처럼 토큰만 보낸다.
    대여·반납 정책을 검증하는 테스트가 SDM 세부에 얽매이지 않게 하는 게 목적이다.
    """

    def _do(nfc_token: str, headers: dict):
        payload = {"nfc_token": nfc_token}
        if _is_real_hardware(db_conn, nfc_token):
            payload["tap_session"] = tap_session(nfc_token, headers)
        return client.post("/usage/checkout", json=payload, headers=headers)

    return _do


@pytest.fixture
def return_equipment(client, db_conn, tap_session):
    """반납을 실제 사용자 경로로 수행한다(checkout 픽스처와 같은 규칙)."""

    def _do(nfc_token: str, headers: dict):
        payload = {"nfc_token": nfc_token}
        if _is_real_hardware(db_conn, nfc_token):
            payload["tap_session"] = tap_session(nfc_token, headers)
        return client.post("/usage/return", json=payload, headers=headers)

    return _do
