"""등록되지 않은 태그는 /ingest 입구에서 버린다.

리더에는 UUID 필터가 없어 주변의 아무 iBeacon이나 올라온다. 이를 받아주면 메모리 상태·
Redis 캐시·실시간 화면까지 전부 오염되므로, 자산으로 등록된 태그만 통과시킨다.
"""

import pytest

from backend.rtls_utils import REDIS_LOCATION_KEY_PREFIX, get_redis_client
from backend.server import tag_obs, tag_state
from backend.tests.conftest import post_signed_ingest

UNKNOWN_TAG = "d546df97-4757-47ef-be09-3e2dcbdd0c77:36788:17584"


def _post_ingest(client, reader_id, observations):
    response = post_signed_ingest(client, {"reader_id": reader_id, "ts": 1000, "observations": observations})
    assert response.status_code == 200, response.text
    return response


def _obs(tag_id, rssi=-50):
    return {"tag_id": tag_id, "rssi": rssi, "count": 1, "last_seen": 1000}


class TestIngestRejectsUnknownTags:
    def test_accepts_the_batch_but_keeps_no_state_for_an_unknown_tag(self, client, seed_reader):
        seed_reader("M501")

        _post_ingest(client, "M501", [_obs(UNKNOWN_TAG)])

        assert UNKNOWN_TAG not in tag_obs
        assert UNKNOWN_TAG not in tag_state

    def test_writes_no_location_history_for_an_unknown_tag(self, client, seed_reader, db_conn):
        seed_reader("M501")

        _post_ingest(client, "M501", [_obs(UNKNOWN_TAG)])

        with db_conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM tag_state_history WHERE tag_id = %s", (UNKNOWN_TAG,))
            assert cur.fetchone()[0] == 0

    def test_keeps_an_unknown_tag_out_of_the_live_view(self, client, seed_reader, seed_user):
        seed_reader("M501")
        _post_ingest(client, "M501", [_obs(UNKNOWN_TAG)])
        _, headers = seed_user(username="admin1", role="admin", position=None)

        body = client.get("/rtls/live", headers=headers).json()

        assert all(item["tag_id"] != UNKNOWN_TAG for item in body["items"])

    def test_leaves_no_last_seen_key_in_the_cache_for_an_unknown_tag(self, client, seed_reader):
        """mark_tags_seen도 필터를 거쳐야 한다 — 안 그러면 스쳐간 비콘만큼 캐시가 계속 쌓인다."""
        seed_reader("M501")

        _post_ingest(client, "M501", [_obs(UNKNOWN_TAG)])

        redis_client = get_redis_client()
        if redis_client is None:
            pytest.skip("Redis를 쓸 수 없는 환경")
        assert redis_client.exists(f"{REDIS_LOCATION_KEY_PREFIX}{UNKNOWN_TAG}:seen") == 0

    def test_a_registered_tag_in_the_same_batch_still_gets_through(self, client, seed_reader, seed_tag, db_conn):
        seed_reader("M501")
        known = seed_tag("EQ-KNOWN-0001")

        _post_ingest(client, "M501", [_obs(UNKNOWN_TAG), _obs(known)])

        assert known in tag_state
        with db_conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM tag_state_history WHERE tag_id = %s", (known,))
            assert cur.fetchone()[0] == 1

    def test_an_inactive_tag_is_treated_as_unregistered(self, client, seed_reader, seed_tag, db_conn):
        """은퇴시킨 태그(is_active=FALSE)가 캐시를 통해 화면에 되살아나면 안 된다."""
        seed_reader("M501")
        retired = seed_tag("EQ-RETIRED-0001")
        with db_conn.cursor() as cur:
            cur.execute("UPDATE tags SET is_active = FALSE WHERE tag_id = %s", (retired,))
        db_conn.commit()

        _post_ingest(client, "M501", [_obs(retired)])

        assert retired not in tag_state
        with db_conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM tag_state_history WHERE tag_id = %s", (retired,))
            assert cur.fetchone()[0] == 0
