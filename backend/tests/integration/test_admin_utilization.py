"""장비 가동률 분석(/admin/utilization) 통합 테스트."""

import datetime as dt

import pytest

from backend.utilization import KST, floor_to_hour


@pytest.fixture
def seed_usage(db_conn, seed_user):
    user_id, _ = seed_user(username="nurse1", role="staff")

    def _seed(tag_id: str, checkout_at: dt.datetime, returned_at: dt.datetime | None):
        status = "returned" if returned_at else "checked_out"
        with db_conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO usage_history (usage_status, user_id, user_name, tag_id, equipment_name,
                                           checkout_at, returned_at, return_method)
                VALUES (%s, %s, 'nurse1', %s, %s, %s, %s, %s)
                """,
                (status, user_id, tag_id, tag_id, checkout_at, returned_at, "test" if returned_at else None),
            )
        db_conn.commit()

    return _seed


@pytest.fixture
def typed_tag(db_conn, seed_tag):
    def _seed(tag_id: str, equipment_type: str, is_active: bool = True):
        seed_tag(tag_id=tag_id, equipment_name=tag_id, is_real_hardware=False)
        with db_conn.cursor() as cur:
            cur.execute(
                "UPDATE tags SET equipment_type = %s, is_active = %s WHERE tag_id = %s",
                (equipment_type, is_active, tag_id),
            )
        db_conn.commit()
        return tag_id

    return _seed


@pytest.fixture
def admin_headers(seed_user):
    _, headers = seed_user(username="admin1", role="admin", position=None)
    return headers


class TestAccess:
    def test_requires_login(self, client):
        assert client.get("/admin/utilization").status_code == 401

    def test_rejects_staff(self, client, seed_user):
        _, headers = seed_user(username="staffer", role="staff")

        assert client.get("/admin/utilization", headers=headers).status_code == 403

    def test_allows_demo_admin(self, client, seed_user):
        _, headers = seed_user(username="demo-admin", role="admin", position=None, is_demo=True)

        assert client.get("/admin/utilization", headers=headers).status_code == 200

    @pytest.mark.parametrize("days", [1, 14, 365])
    def test_rejects_unsupported_days(self, client, admin_headers, days):
        response = client.get(f"/admin/utilization?days={days}", headers=admin_headers)

        assert response.status_code == 400


class TestUtilizationResponse:
    def test_aggregates_usage_history_and_starts_at_first_record(self, client, admin_headers, typed_tag, seed_usage):
        typed_tag("pump-a", "수액펌프")
        now = dt.datetime.now(KST)
        seed_usage("pump-a", now - dt.timedelta(hours=3), now - dt.timedelta(hours=2))

        response = client.get("/admin/utilization", headers=admin_headers)

        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is True
        assert body["period"]["days"] == 30
        start = dt.datetime.fromisoformat(body["period"]["start"])
        end = dt.datetime.fromisoformat(body["period"]["end"])
        assert start == floor_to_hour(now - dt.timedelta(hours=3))
        assert end == floor_to_hour(now)
        assert [item["equipment_type"] for item in body["types"]] == ["수액펌프"]
        item = body["types"][0]
        assert item["checkout_count"] == 1
        assert item["utilization"] == pytest.approx(1 / 3)
        assert len(body["heatmap"]["all"]) == 7
        assert len(body["hourly"]["all"]["weekday"]) == 24

    def test_keeps_requested_period_when_history_is_older(self, client, admin_headers, typed_tag, seed_usage):
        typed_tag("pump-a", "수액펌프")
        now = dt.datetime.now(KST)
        seed_usage("pump-a", now - dt.timedelta(days=40), now - dt.timedelta(days=40, hours=-1))

        body = client.get("/admin/utilization?days=7", headers=admin_headers).json()

        start = dt.datetime.fromisoformat(body["period"]["start"])
        end = dt.datetime.fromisoformat(body["period"]["end"])
        assert body["period"]["days"] == 7
        assert end - start == dt.timedelta(days=7)
        assert body["types"][0]["checkout_count"] == 0

    def test_counts_open_checkout(self, client, admin_headers, typed_tag, seed_usage):
        typed_tag("pump-a", "수액펌프")
        seed_usage("pump-a", dt.datetime.now(KST) - dt.timedelta(hours=5), None)

        body = client.get("/admin/utilization", headers=admin_headers).json()

        assert body["types"][0]["checkout_count"] == 1
        assert body["types"][0]["utilization"] > 0

    def test_excludes_inactive_tags(self, client, admin_headers, typed_tag, seed_usage):
        typed_tag("pump-a", "수액펌프")
        typed_tag("old-pump", "수액펌프", is_active=False)
        seed_usage("old-pump", dt.datetime.now(KST) - dt.timedelta(hours=3), dt.datetime.now(KST))

        body = client.get("/admin/utilization", headers=admin_headers).json()

        assert body["types"][0]["unit_count"] == 1
        assert [u["tag_id"] for u in body["types"][0]["units"]] == ["pump-a"]
        assert body["types"][0]["checkout_count"] == 0

    def test_empty_when_no_tags(self, client, admin_headers):
        body = client.get("/admin/utilization", headers=admin_headers).json()

        assert body["types"] == []
        assert body["summary"]["utilization"] == 0
