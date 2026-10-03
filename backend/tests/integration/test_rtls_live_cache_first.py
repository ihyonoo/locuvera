"""GET /rtls/live가 태그별 최신 위치를 Redis에서 먼저 읽는지 검증한다.

Redis가 살아 있으면 캐시에 없는 활성 태그만 DB에서 태그별로 조회해 캐시에 채운다.
Redis가 죽어도 tag_state_history 전체 스캔은 하지 않고, 활성 태그 전부를 태그별로 조회한다.
"""

import datetime as dt
import json

import pytest

import backend.server as server
from backend.rtls_utils import (
    cache_location_updates,
    cache_tag_location_snapshot,
    get_redis_client,
    get_tag_location_cache_key,
    get_tag_seen_cache_key,
)

READER_LOCATIONS = {"M999": "테스트 리더", "M998": "다른 리더"}


@pytest.fixture
def forbid_full_scan(monkeypatch):
    """태그를 지정하지 않은 조회(이력 전체 스캔)가 다시 생기면 실패시킨다."""
    real = server.load_latest_db_tag_locations

    def guarded(tag_ids=None):
        if tag_ids is None:
            raise AssertionError("tag_state_history 전체 스캔이 실행됐다")
        return real(tag_ids)

    monkeypatch.setattr(server, "load_latest_db_tag_locations", guarded)


@pytest.fixture
def seed_readers(seed_reader):
    seed_reader("M999", location_name="테스트 리더")
    seed_reader("M998", location_name="다른 리더")


def _insert_history(db_conn, tag_id, reader_id, epoch):
    with db_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO tag_state_history (tag_id, reader_id, rssi, decided_at) VALUES (%s, %s, %s, %s)",
            (tag_id, reader_id, -55, dt.datetime.fromtimestamp(epoch, tz=dt.UTC)),
        )
    db_conn.commit()


def _live_items(client, headers):
    response = client.get("/rtls/live", headers=headers)
    assert response.status_code == 200
    return {item["tag_id"]: item for item in response.json()["items"]}


def _cached(tag_id):
    raw = get_redis_client().get(get_tag_location_cache_key(tag_id))
    return json.loads(raw) if raw else None


class TestRtlsLiveCacheFirst:
    def test_db_failure_keeps_existing_location_and_seen_cache(
        self, client, seed_readers, seed_tag, seed_user, monkeypatch
    ):
        seed_tag("EQ-TEST-0001")
        cache_tag_location_snapshot("EQ-TEST-0001", "M999", 1_700_000_000, reader_locations=READER_LOCATIONS)
        seen_key = get_tag_seen_cache_key("EQ-TEST-0001")
        get_redis_client().set(seen_key, 1_700_000_001)
        _, headers = seed_user(username="staffer")
        real_load = server.load_active_tag_ids

        def db_down(*_):
            raise RuntimeError("DB down")

        def failed_load():
            with monkeypatch.context() as patch:
                patch.setattr("backend.rtls_utils.psycopg.connect", db_down)
                return real_load()

        monkeypatch.setattr(server, "load_active_tag_ids", failed_load)

        response = client.get("/rtls/live", headers=headers)

        assert response.status_code == 503
        assert _cached("EQ-TEST-0001") is not None
        assert get_redis_client().get(seen_key) is not None

    def test_stale_cache_does_not_restore_inactive_or_deleted_tags(
        self, client, db_conn, seed_readers, seed_tag, seed_user
    ):
        seed_tag("EQ-INACTIVE")
        seed_tag("EQ-DELETED")
        for tag_id in ("EQ-INACTIVE", "EQ-DELETED"):
            cache_tag_location_snapshot(tag_id, "M999", 1_700_000_000, reader_locations=READER_LOCATIONS)
        with db_conn.cursor() as cur:
            cur.execute("UPDATE tags SET is_active = FALSE WHERE tag_id = 'EQ-INACTIVE'")
            cur.execute("DELETE FROM tags WHERE tag_id = 'EQ-DELETED'")
        db_conn.commit()
        _, headers = seed_user(username="staffer")

        items = _live_items(client, headers)

        assert "EQ-INACTIVE" not in items
        assert "EQ-DELETED" not in items
        assert _cached("EQ-INACTIVE") is None
        assert _cached("EQ-DELETED") is None

    def test_all_cached_tags_are_served_without_full_scan(
        self, client, seed_readers, seed_tag, seed_user, forbid_full_scan
    ):
        seed_tag("EQ-TEST-0001")
        cache_tag_location_snapshot("EQ-TEST-0001", "M999", 1_700_000_000, reader_locations=READER_LOCATIONS)
        _, headers = seed_user(username="staffer", role="staff")

        items = _live_items(client, headers)

        assert items["EQ-TEST-0001"]["reader_id"] == "M999"
        assert items["EQ-TEST-0001"]["location"] == "테스트 리더"
        assert items["EQ-TEST-0001"]["updated_at"] == 1_700_000_000

    def test_uncached_active_tag_is_loaded_from_db_and_written_back(
        self, client, db_conn, seed_readers, seed_tag, seed_user, forbid_full_scan
    ):
        seed_tag("EQ-TEST-0001")
        seed_tag("EQ-TEST-0002")
        cache_tag_location_snapshot("EQ-TEST-0001", "M999", 1_700_000_000, reader_locations=READER_LOCATIONS)
        _insert_history(db_conn, "EQ-TEST-0002", "M999", 1_700_000_100)
        _insert_history(db_conn, "EQ-TEST-0002", "M998", 1_700_000_200)
        _, headers = seed_user(username="staffer", role="staff")

        items = _live_items(client, headers)

        assert items["EQ-TEST-0002"]["reader_id"] == "M998"
        assert items["EQ-TEST-0002"]["updated_at"] == 1_700_000_200
        assert _cached("EQ-TEST-0002")["reader_id"] == "M998"

    def test_empty_cache_uses_per_tag_lookup_not_full_scan(
        self, client, db_conn, seed_readers, seed_tag, seed_user, forbid_full_scan
    ):
        seed_tag("EQ-TEST-0001")
        seed_tag("EQ-TEST-0002")
        _insert_history(db_conn, "EQ-TEST-0001", "M999", 1_700_000_100)
        _, headers = seed_user(username="staffer", role="staff")

        items = _live_items(client, headers)

        assert items["EQ-TEST-0001"]["reader_id"] == "M999"
        # 위치가 한 번도 잡힌 적 없는 태그는 위치 없이 목록에 남는다.
        assert items["EQ-TEST-0002"]["reader_id"] is None

    def test_redis_down_uses_per_tag_lookup_not_full_scan(
        self, client, db_conn, seed_readers, seed_tag, seed_user, forbid_full_scan, monkeypatch
    ):
        seed_tag("EQ-TEST-0001")
        _insert_history(db_conn, "EQ-TEST-0001", "M998", 1_700_000_100)
        _, headers = seed_user(username="staffer", role="staff")
        monkeypatch.setattr("backend.rtls_utils.get_redis_client", lambda: None)

        items = _live_items(client, headers)

        assert items["EQ-TEST-0001"]["reader_id"] == "M998"
        assert items["EQ-TEST-0001"]["location"] == "다른 리더"


class TestCacheWriteBackOnlyIfMissing:
    def test_does_not_overwrite_fresher_value_written_meanwhile(self):
        cache_tag_location_snapshot("EQ-TEST-0001", "M998", 1_700_000_500, reader_locations=READER_LOCATIONS)

        cache_location_updates(
            {"EQ-TEST-0001": ("M999", None, 1_700_000_100)},
            reader_locations=READER_LOCATIONS,
            only_if_missing=True,
        )

        assert _cached("EQ-TEST-0001")["reader_id"] == "M998"
        assert _cached("EQ-TEST-0001")["changed_at"] == 1_700_000_500

    def test_writes_when_key_absent(self):
        cache_location_updates(
            {"EQ-TEST-0001": ("M999", None, 1_700_000_100)},
            reader_locations=READER_LOCATIONS,
            only_if_missing=True,
        )

        assert _cached("EQ-TEST-0001")["reader_id"] == "M999"
