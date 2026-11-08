"""비콘 배터리 잔량: /ingest 관측의 battery_pct가 GET /rtls/live 태그 항목까지 전달되는지."""

from backend.tests.conftest import post_signed_ingest


def _ingest(client, tag_id, **extra):
    return post_signed_ingest(
        client,
        {
            "reader_id": "M501",
            "ts": 1000,
            "observations": [{"tag_id": tag_id, "rssi": -50, "count": 1, "last_seen": 1000, **extra}],
        },
    )


def _battery(client, headers, tag_id):
    items = client.get("/rtls/live", headers=headers).json()["items"]
    return next(item for item in items if item["tag_id"] == tag_id)["battery_pct"]


class TestBatteryLevel:
    def test_live_view_shows_the_latest_reported_level(self, client, seed_reader, seed_tag, seed_user):
        seed_reader("M501")
        tag_id = seed_tag("EQ-REAL-0001")
        _, headers = seed_user(username="admin1", role="admin")

        assert _ingest(client, tag_id, battery_pct=87).status_code == 200
        assert _battery(client, headers, tag_id) == 87

        assert _ingest(client, tag_id, battery_pct=86).status_code == 200
        assert _battery(client, headers, tag_id) == 86

    def test_level_is_null_until_a_reader_reports_one(self, client, seed_reader, seed_tag, seed_user):
        seed_reader("M501")
        tag_id = seed_tag("EQ-REAL-0001")
        _, headers = seed_user(username="admin1", role="admin")

        assert _ingest(client, tag_id).status_code == 200
        assert _battery(client, headers, tag_id) is None

    def test_rejects_a_level_outside_zero_to_hundred(self, client, seed_reader, seed_tag):
        seed_reader("M501")
        tag_id = seed_tag("EQ-REAL-0001")

        assert _ingest(client, tag_id, battery_pct=101).status_code == 422
