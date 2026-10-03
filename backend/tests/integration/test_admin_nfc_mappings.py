"""NFC 매핑 목록 조회(/admin/nfc-mappings) 통합 테스트."""


def test_new_admin_can_read_but_cannot_change_nfc_mapping(client, seed_user, seed_tag, db_conn):
    _, headers = seed_user(username="new_admin", role="admin")
    seed_tag(tag_id="EQ-MAP-001", nfc_token="pump-001")

    assert client.get("/admin/nfc-mappings", headers=headers).status_code == 200
    assert (
        client.post(
            "/admin/nfc-mappings",
            json={"tag_id": "EQ-MAP-001", "nfc_token": "pump-002"},
            headers=headers,
        ).status_code
        == 403
    )
    assert client.delete("/admin/nfc-mappings/EQ-MAP-001", headers=headers).status_code == 403
    with db_conn.cursor() as cur:
        cur.execute("SELECT nfc_token FROM tags WHERE tag_id = 'EQ-MAP-001'")
        assert cur.fetchone()[0] == "pump-001"


def test_new_mapping_requires_consistent_slug_and_three_digit_number(client, seed_user, seed_tag):
    _, headers = seed_user(username="nfc_writer", role="admin", can_manage_nfc=True)
    seed_tag(tag_id="EQ-MAP-002")
    for token in ("Pump-001", "pump%2D001", "pump-1", "pump_001", "123-001"):
        response = client.post(
            "/admin/nfc-mappings", json={"tag_id": "EQ-MAP-002", "nfc_token": token}, headers=headers
        )
        assert response.status_code == 400, token

    response = client.post(
        "/admin/nfc-mappings",
        json={"tag_id": "EQ-MAP-002", "nfc_token": "infusion-pump-001"},
        headers=headers,
    )
    assert response.status_code == 200


class TestListNfcMappings:
    def test_requires_admin_role(self, client, seed_user):
        _, headers = seed_user(username="staffer", role="staff")

        response = client.get("/admin/nfc-mappings", headers=headers)

        assert response.status_code == 403

    def test_marks_simulated_equipment_so_the_admin_can_hide_it(self, client, seed_tag, seed_user):
        seed_tag(tag_id="EQ-REAL-0001", equipment_name="실물 장비", is_real_hardware=True)
        seed_tag(tag_id="EQ-SIM-0001", equipment_name="모의 장비", is_real_hardware=False)
        _, headers = seed_user(username="admin1", role="admin", position=None)

        response = client.get("/admin/nfc-mappings", headers=headers)

        assert response.status_code == 200
        items = {item["tag_id"]: item for item in response.json()["items"]}
        assert items["EQ-REAL-0001"]["is_real_hardware"] is True
        assert items["EQ-SIM-0001"]["is_real_hardware"] is False

    def test_reports_when_each_tag_was_registered_so_the_admin_can_sort_by_it(self, client, seed_tag, seed_user):
        seed_tag(tag_id="EQ-0001", equipment_name="장비 1")
        _, headers = seed_user(username="admin1", role="admin", position=None)

        response = client.get("/admin/nfc-mappings", headers=headers)

        assert response.status_code == 200
        item = response.json()["items"][0]
        assert isinstance(item["created_at"], int)
        assert item["created_at"] > 0


class TestNfcMappingsNtagBinding:
    """매핑 화면이 칩 바인딩 현황을 보여주려면 목록이 그 값을 실어와야 한다."""

    def test_reports_the_chip_uid_and_tap_count_for_a_bound_tag(
        self, client, seed_tag, seed_user, bind_ntag, tap_session
    ):
        seed_tag(tag_id="EQ-MAP-0001", equipment_name="수액펌프-501", nfc_token="pump-501")
        _, staff_headers = seed_user(username="staff-map-1")
        uid = bind_ntag("pump-501")
        tap_session("pump-501", staff_headers)  # 카운터를 1 올린다
        _, admin_headers = seed_user(username="admin-map-1", role="admin")

        body = client.get("/admin/nfc-mappings", headers=admin_headers).json()
        item = next(i for i in body["items"] if i["tag_id"] == "EQ-MAP-0001")

        assert item["ntag_uid"] == uid
        assert item["ntag_bound"] is True
        assert item["ntag_last_ctr"] == 1

    def test_marks_an_unbound_tag_so_the_admin_can_tell_it_apart(self, client, seed_tag, seed_user):
        """UID가 비어 있는 것과 바인딩이 해제된 것은 화면에서 구분돼야 한다."""
        seed_tag(tag_id="EQ-MAP-0002", equipment_name="제세동기-501", nfc_token="defib-501")
        _, admin_headers = seed_user(username="admin-map-2", role="admin")

        body = client.get("/admin/nfc-mappings", headers=admin_headers).json()
        item = next(i for i in body["items"] if i["tag_id"] == "EQ-MAP-0002")

        assert item["ntag_uid"] is None
        assert item["ntag_bound"] is False
        assert item["ntag_last_ctr"] == 0

    def test_drops_the_rtls_snapshot_the_screen_no_longer_shows(self, client, seed_tag, seed_user):
        """위치·최근 수신은 /admin/devices의 관심사다. 태그마다 위치를 조회하던 비용도 사라진다."""
        seed_tag(tag_id="EQ-MAP-0003", equipment_name="수액펌프-502", nfc_token="pump-502")
        _, admin_headers = seed_user(username="admin-map-3", role="admin")

        body = client.get("/admin/nfc-mappings", headers=admin_headers).json()
        item = next(i for i in body["items"] if i["tag_id"] == "EQ-MAP-0003")

        assert "location" not in item
        assert "updated_at" not in item
        assert "is_stale" not in item
