import asyncio
import hashlib
import hmac
import json
import secrets
import time

import pytest

from backend import rtls_auth, rtls_utils
from backend.server import tag_obs


def _signed_headers(body: bytes, reader_id: str, key: str, *, nonce: str | None = None, timestamp: str | None = None):
    timestamp = timestamp or str(int(time.time()))
    nonce = nonce or secrets.token_hex(16)
    message = f"v1\n{reader_id}\n{timestamp}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode("ascii")
    signature = hmac.new(key.encode("utf-8"), message, hashlib.sha256).hexdigest()
    return {
        "X-RTLS-Reader-ID": reader_id,
        "X-RTLS-Timestamp": timestamp,
        "X-RTLS-Nonce": nonce,
        "X-RTLS-Signature": signature,
        "Content-Type": "application/json",
    }


def test_unsigned_ingest_has_no_position_side_effect(client, seed_reader, seed_tag, db_conn):
    seed_reader("M501")
    tag_id = seed_tag()
    body = {
        "reader_id": "M501",
        "ts": int(time.time()),
        "observations": [{"tag_id": tag_id, "rssi": -60, "count": 1, "last_seen": int(time.time())}],
    }

    response = client.post("/ingest", json=body)

    assert response.status_code == 401
    assert tag_id not in tag_obs
    with db_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM tag_state_history WHERE tag_id = %s", (tag_id,))
        assert cur.fetchone()[0] == 0


def test_signed_ingest_accepts_once_and_rejects_replay(client, seed_reader, seed_tag):
    seed_reader("M501")
    tag_id = seed_tag()
    body = json.dumps(
        {
            "reader_id": "M501",
            "ts": int(time.time()),
            "observations": [{"tag_id": tag_id, "rssi": -60, "count": 1, "last_seen": int(time.time())}],
        },
        separators=(",", ":"),
    ).encode()
    headers = _signed_headers(body, "M501", "test-reader-key-32-bytes-000001")

    assert client.post("/ingest", content=body, headers=headers).status_code == 200
    assert client.post("/ingest", content=body, headers=headers).status_code == 401


def test_unknown_or_inactive_reader_cannot_register_itself(client, seed_reader, db_conn):
    seed_reader("M501")
    with db_conn.cursor() as cur:
        cur.execute("UPDATE readers SET is_active = FALSE WHERE reader_id = 'M501'")
    db_conn.commit()
    body = b'{"reader_id":"M501","ts":0,"observations":[]}'
    headers = _signed_headers(body, "M501", "test-reader-key-32-bytes-000001")

    assert client.post("/ingest", content=body, headers=headers).status_code == 403
    with db_conn.cursor() as cur:
        cur.execute("SELECT is_active FROM readers WHERE reader_id = 'M501'")
        assert cur.fetchone()[0] is False


def test_signed_ingest_rejects_tampered_body_and_reader_id(client, seed_reader):
    seed_reader("M501")
    original = b'{"reader_id":"M501","ts":0,"observations":[]}'
    headers = _signed_headers(original, "M501", "test-reader-key-32-bytes-000001")

    assert client.post("/ingest", content=original.replace(b'"ts":0', b'"ts":1'), headers=headers).status_code == 401
    assert client.post("/ingest", content=original.replace(b"M501", b"M502"), headers=headers).status_code == 401


def test_signed_ingest_rejects_expired_timestamp(client, seed_reader):
    seed_reader("M501")
    body = b'{"reader_id":"M501","ts":0,"observations":[]}'
    headers = _signed_headers(body, "M501", "test-reader-key-32-bytes-000001", timestamp=str(int(time.time()) - 120))

    assert client.post("/ingest", content=body, headers=headers).status_code == 401


def test_signed_ingest_rejects_oversized_timestamp(client, seed_reader):
    seed_reader("M501")
    body = b'{"reader_id":"M501","ts":0,"observations":[]}'
    headers = _signed_headers(body, "M501", "test-reader-key-32-bytes-000001")
    headers["X-RTLS-Timestamp"] = "1" * 4301

    assert client.post("/ingest", content=body, headers=headers).status_code == 401


def test_tag_lookup_failure_rejects_ingest_without_advancing_reader(
    client, seed_reader, seed_tag, db_conn, monkeypatch
):
    seed_reader("M501")
    tag_id = seed_tag()
    body = json.dumps(
        {
            "reader_id": "M501",
            "ts": int(time.time()),
            "observations": [{"tag_id": tag_id, "rssi": -60, "count": 1, "last_seen": int(time.time())}],
        }
    ).encode()
    headers = _signed_headers(body, "M501", "test-reader-key-32-bytes-000001")

    def failed_lookup(_tag_ids, *, strict=False):
        assert strict
        raise RuntimeError("tag database unavailable")

    monkeypatch.setattr("backend.server.filter_registered_tag_ids", failed_lookup)
    with db_conn.cursor() as cur:
        cur.execute("SELECT last_seen_at FROM readers WHERE reader_id = 'M501'")
        before = cur.fetchone()[0]

    response = client.post("/ingest", content=body, headers=headers)

    assert response.status_code >= 500
    assert tag_id not in tag_obs
    with db_conn.cursor() as cur:
        cur.execute("SELECT last_seen_at FROM readers WHERE reader_id = 'M501'")
        assert cur.fetchone()[0] == before


def test_strict_tag_lookup_propagates_database_failure(monkeypatch):
    def failed_connect(*_args, **_kwargs):
        raise RuntimeError("tag database unavailable")

    monkeypatch.setattr(rtls_utils.psycopg, "connect", failed_connect)
    with pytest.raises(RuntimeError, match="tag database unavailable"):
        rtls_utils.filter_registered_tag_ids({"sample"}, strict=True)


def test_signed_ingest_limits_requests_per_reader(client, seed_reader, monkeypatch):
    seed_reader("M501")
    frozen = int(time.time())
    monkeypatch.setattr("backend.rtls_auth.time.time", lambda: frozen)
    body = b'{"reader_id":"M501","ts":0,"observations":[]}'

    statuses = [
        client.post(
            "/ingest", content=body, headers=_signed_headers(body, "M501", "test-reader-key-32-bytes-000001")
        ).status_code
        for _ in range(6)
    ]

    assert statuses == [200] * 5 + [429]


def test_blocking_auth_dependencies_do_not_run_on_event_loop(client, seed_reader, monkeypatch):
    seed_reader("M501")
    original_lookup = rtls_auth._reader_key
    original_redis = rtls_auth.get_redis_client

    def reader_key(reader_id):
        with pytest.raises(RuntimeError):
            asyncio.get_running_loop()
        return original_lookup(reader_id)

    class RedisProxy:
        def __init__(self, inner):
            self.inner = inner

        def eval(self, *args):
            with pytest.raises(RuntimeError):
                asyncio.get_running_loop()
            return self.inner.eval(*args)

    monkeypatch.setattr(rtls_auth, "_reader_key", reader_key)
    monkeypatch.setattr(rtls_auth, "get_redis_client", lambda: RedisProxy(original_redis()))
    body = b'{"reader_id":"M501","ts":0,"observations":[]}'
    headers = _signed_headers(body, "M501", "test-reader-key-32-bytes-000001")

    assert client.post("/ingest", content=body, headers=headers).status_code == 200
