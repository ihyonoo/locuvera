"""GET /rtls/live?hide_simulated=true 통합 테스트.

직원 화면(장비 검색)에서 모의 장비를 감추기 위한 서버 필터. 응답에서 항목을 빼줄 뿐,
어떤 항목이 모의인지 알려주는 is_real_hardware 필드는 직원에게 여전히 노출하지 않는다.
"""

from backend.tests.conftest import post_signed_ingest


def _ingest(client, reader_id, tag_id, rssi=-50):
    response = post_signed_ingest(
        client,
        {
            "reader_id": reader_id,
            "ts": 1000,
            "observations": [{"tag_id": tag_id, "rssi": rssi, "count": 1, "last_seen": 1000}],
        },
    )
    assert response.status_code == 200, response.text
    return response


class TestRtlsLiveHideSimulated:
    def test_drops_simulated_tags_for_staff(self, client, seed_reader, seed_tag, seed_user):
        seed_reader("M501")
        seed_tag("EQ-REAL-0001", is_real_hardware=True)
        seed_tag("EQ-SIM-0001", is_real_hardware=False)
        _ingest(client, "M501", "EQ-REAL-0001")
        _ingest(client, "M501", "EQ-SIM-0001")
        _, headers = seed_user(username="staffer", role="staff")

        body = client.get("/rtls/live?hide_simulated=true", headers=headers).json()

        tag_ids = {item["tag_id"] for item in body["items"]}
        assert "EQ-REAL-0001" in tag_ids
        assert "EQ-SIM-0001" not in tag_ids

    def test_still_hides_which_items_are_simulated_from_staff(self, client, seed_reader, seed_tag, seed_user):
        seed_reader("M501")
        seed_tag("EQ-REAL-0001", is_real_hardware=True)
        _ingest(client, "M501", "EQ-REAL-0001")
        _, headers = seed_user(username="staffer", role="staff")

        body = client.get("/rtls/live?hide_simulated=true", headers=headers).json()

        assert all("is_real_hardware" not in item for item in body["items"])

    def test_keeps_every_tag_when_the_flag_is_off(self, client, seed_reader, seed_tag, seed_user):
        seed_reader("M501")
        seed_tag("EQ-REAL-0001", is_real_hardware=True)
        seed_tag("EQ-SIM-0001", is_real_hardware=False)
        _ingest(client, "M501", "EQ-REAL-0001")
        _ingest(client, "M501", "EQ-SIM-0001")
        _, headers = seed_user(username="staffer", role="staff")

        body = client.get("/rtls/live", headers=headers).json()

        tag_ids = {item["tag_id"] for item in body["items"]}
        assert {"EQ-REAL-0001", "EQ-SIM-0001"} <= tag_ids

    def test_leaves_readers_alone_so_the_map_keeps_its_zones(self, client, seed_reader, seed_tag, seed_user):
        seed_reader("M501", is_real_hardware=True)
        seed_reader("M101", is_real_hardware=False)
        seed_tag("EQ-REAL-0001", is_real_hardware=True)
        _ingest(client, "M501", "EQ-REAL-0001")
        _, headers = seed_user(username="staffer", role="staff")

        body = client.get("/rtls/live?hide_simulated=true", headers=headers).json()

        reader_ids = {reader["reader_id"] for reader in body["readers"]}
        assert {"M501", "M101"} <= reader_ids

    def test_reveals_reader_provenance_only_when_staff_asks_to_distinguish(
        self, client, seed_reader, seed_tag, seed_user
    ):
        seed_reader("M501", is_real_hardware=True)
        seed_reader("M101", is_real_hardware=False)
        _, headers = seed_user(username="staffer", role="staff")

        plain = client.get("/rtls/live", headers=headers).json()
        distinguishing = client.get("/rtls/live?hide_simulated=true", headers=headers).json()

        # 기본 화면에서는 어느 구역이 시뮬레이션인지 알 수 없어야 한다.
        assert all("is_real_hardware" not in reader for reader in plain["readers"])
        # 구분을 명시적으로 요청했을 때만 알려준다.
        by_id = {reader["reader_id"]: reader for reader in distinguishing["readers"]}
        assert by_id["M501"]["is_real_hardware"] is True
        assert by_id["M101"]["is_real_hardware"] is False

    def test_works_for_admin_too(self, client, seed_reader, seed_tag, seed_user):
        seed_reader("M501")
        seed_tag("EQ-REAL-0001", is_real_hardware=True)
        seed_tag("EQ-SIM-0001", is_real_hardware=False)
        _ingest(client, "M501", "EQ-REAL-0001")
        _ingest(client, "M501", "EQ-SIM-0001")
        _, headers = seed_user(username="admin1", role="admin", position=None)

        body = client.get("/rtls/live?hide_simulated=true", headers=headers).json()

        tag_ids = {item["tag_id"] for item in body["items"]}
        assert tag_ids == {"EQ-REAL-0001"}
