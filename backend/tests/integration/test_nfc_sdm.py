"""NTAG 424 DNA SDM 탭 검증과 탭 세션 강제에 대한 통합 테스트.

실물 태그(is_real_hardware = TRUE)는 유효한 탭 없이 대여/반납할 수 없어야 하고,
시뮬레이션 태그는 지금까지처럼 토큰만으로 통과해야 한다.
"""

import psycopg
import pytest

from backend.tests.conftest import TEST_DATABASE_URL, make_sdm_query


def _audit_rows(db_conn):
    with db_conn.cursor() as cur:
        cur.execute("SELECT result, reason FROM usage_nfc_events ORDER BY event_id")
        rows = cur.fetchall()
    db_conn.commit()
    return rows


def _counter(db_conn, nfc_token):
    with db_conn.cursor() as cur:
        cur.execute("SELECT ntag_last_ctr FROM tags WHERE nfc_token = %s", (nfc_token,))
        value = cur.fetchone()[0]
    db_conn.commit()
    return value


class TestTapVerification:
    def test_a_valid_tap_mints_a_session_and_advances_the_counter(
        self, client, db_conn, seed_tag, seed_user, bind_ntag
    ):
        seed_tag(tag_id="EQ-SDM-0001", equipment_name="수액펌프-001", nfc_token="pump-001")
        uid = bind_ntag("pump-001")
        _, headers = seed_user(username="nurse-sdm-1")

        response = client.get("/nfc/pump-001", params=make_sdm_query(uid, 1), headers=headers)

        assert response.status_code == 200
        body = response.json()
        assert body["tap_session"]
        assert body["item"]["equipment_name"] == "수액펌프-001"
        assert _counter(db_conn, "pump-001") == 1

    def test_replaying_a_spent_url_is_rejected_and_the_counter_holds(
        self, client, db_conn, seed_tag, seed_user, bind_ntag
    ):
        seed_tag(tag_id="EQ-SDM-0002", equipment_name="수액펌프-002", nfc_token="pump-002")
        uid = bind_ntag("pump-002")
        _, headers = seed_user(username="nurse-sdm-2")
        query = make_sdm_query(uid, 7)

        assert client.get("/nfc/pump-002", params=query, headers=headers).status_code == 200
        replay = client.get("/nfc/pump-002", params=query, headers=headers)

        assert replay.status_code == 403
        assert _counter(db_conn, "pump-002") == 7
        assert ("rejected", "counter_replay") in _audit_rows(db_conn)

    def test_a_lower_counter_is_rejected_as_replay(self, client, seed_tag, seed_user, bind_ntag):
        seed_tag(tag_id="EQ-SDM-0003", equipment_name="수액펌프-003", nfc_token="pump-003")
        uid = bind_ntag("pump-003")
        _, headers = seed_user(username="nurse-sdm-3")

        assert client.get("/nfc/pump-003", params=make_sdm_query(uid, 10), headers=headers).status_code == 200
        stale = client.get("/nfc/pump-003", params=make_sdm_query(uid, 4), headers=headers)

        assert stale.status_code == 403

    def test_a_tampered_cmac_is_rejected_and_audited(self, client, db_conn, seed_tag, seed_user, bind_ntag):
        seed_tag(tag_id="EQ-SDM-0004", equipment_name="수액펌프-004", nfc_token="pump-004")
        uid = bind_ntag("pump-004")
        _, headers = seed_user(username="nurse-sdm-4")
        query = make_sdm_query(uid, 1)
        query["cmac"] = f"{(int(query['cmac'], 16) ^ 1):016X}"

        response = client.get("/nfc/pump-004", params=query, headers=headers)

        assert response.status_code == 403
        assert ("rejected", "cmac_mismatch") in _audit_rows(db_conn)

    def test_a_query_string_moved_onto_another_equipment_is_rejected(
        self, client, db_conn, seed_tag, seed_user, bind_ntag
    ):
        """부품 바꿔치기 — A의 유효한 쿼리스트링을 B의 URL에 붙이는 시도."""
        seed_tag(tag_id="EQ-SDM-0005", equipment_name="수액펌프-005", nfc_token="pump-005")
        seed_tag(tag_id="EQ-SDM-0006", equipment_name="제세동기-001", nfc_token="defib-001")
        uid_a = bind_ntag("pump-005")
        bind_ntag("defib-001")
        _, headers = seed_user(username="nurse-sdm-5")

        response = client.get("/nfc/defib-001", params=make_sdm_query(uid_a, 1), headers=headers)

        assert response.status_code == 403
        assert ("rejected", "uid_token_mismatch") in _audit_rows(db_conn)

    def test_a_tap_without_sdm_parameters_is_404_without_an_audit_row(
        self, client, db_conn, seed_tag, seed_user, bind_ntag
    ):
        """즐겨찾기나 URL 복사로 들어온 경우 — 조회 화면 자체가 열리지 않는다."""
        seed_tag(tag_id="EQ-SDM-0007", equipment_name="수액펌프-007", nfc_token="pump-007")
        bind_ntag("pump-007")
        _, headers = seed_user(username="nurse-sdm-7")

        response = client.get("/nfc/pump-007", headers=headers)

        assert response.status_code == 404
        assert _audit_rows(db_conn) == []

    @pytest.mark.parametrize(
        "params",
        [
            {"uid": "04DE5F1E", "ctr": "000001", "cmac": "0011223344556677"},
            {"uid": "04DE5F1EACC040", "ctr": "0001", "cmac": "0011223344556677"},
            {"uid": "04DE5F1EACC040", "ctr": "000000", "cmac": "0011223344556677"},
        ],
    )
    def test_malformed_parameters_are_404(self, client, seed_tag, seed_user, bind_ntag, params):
        seed_tag(tag_id="EQ-SDM-0008", equipment_name="수액펌프-008", nfc_token="pump-008")
        bind_ntag("pump-008")
        _, headers = seed_user(username="nurse-sdm-8")

        assert client.get("/nfc/pump-008", params=params, headers=headers).status_code == 404

    def test_an_unknown_uid_is_404_without_an_audit_row(self, client, db_conn, seed_tag, seed_user, bind_ntag):
        seed_tag(tag_id="EQ-SDM-0009", equipment_name="수액펌프-009", nfc_token="pump-009")
        bind_ntag("pump-009")
        _, headers = seed_user(username="nurse-sdm-9")

        response = client.get("/nfc/pump-009", params=make_sdm_query("04AABBCCDDEE80", 1), headers=headers)

        assert response.status_code == 404
        assert _audit_rows(db_conn) == []

    def test_an_unbound_tag_is_404(self, client, seed_tag, seed_user):
        """바인딩되지 않은 태그는 UID를 몰라 탭 자체가 성립하지 않는다."""
        seed_tag(tag_id="EQ-SDM-0010", equipment_name="수액펌프-010", nfc_token="pump-010")
        _, headers = seed_user(username="nurse-sdm-10")

        response = client.get("/nfc/pump-010", params=make_sdm_query("04AABBCCDDEE81", 1), headers=headers)

        assert response.status_code == 404


class TestTapSessionEnforcement:
    def test_real_hardware_checkout_requires_a_session(self, client, seed_tag, seed_user, bind_ntag):
        seed_tag(tag_id="EQ-SES-0001", equipment_name="수액펌프-101", nfc_token="pump-101")
        bind_ntag("pump-101")
        _, headers = seed_user(username="nurse-ses-1")

        response = client.post("/usage/checkout", json={"nfc_token": "pump-101"}, headers=headers)

        assert response.status_code == 403

    def test_a_tapped_checkout_succeeds(self, client, seed_tag, seed_user, tap_session):
        seed_tag(tag_id="EQ-SES-0002", equipment_name="수액펌프-102", nfc_token="pump-102")
        _, headers = seed_user(username="nurse-ses-2")

        response = client.post(
            "/usage/checkout",
            json={"nfc_token": "pump-102", "tap_session": tap_session("pump-102", headers)},
            headers=headers,
        )

        assert response.status_code == 200
        assert response.json()["asset_status"] == "checked_out"

    def test_the_action_response_carries_a_refreshed_snapshot(self, client, seed_tag, seed_user, tap_session):
        """탭한 URL은 이미 소비돼 재조회할 수 없으므로, 갱신된 상태를 응답이 실어와야 한다."""
        seed_tag(tag_id="EQ-SES-0003", equipment_name="수액펌프-103", nfc_token="pump-103")
        _, headers = seed_user(username="nurse-ses-3")

        response = client.post(
            "/usage/checkout",
            json={"nfc_token": "pump-103", "tap_session": tap_session("pump-103", headers)},
            headers=headers,
        )

        assert response.json()["item"]["asset_status"] == "checked_out"

    def test_a_session_cannot_be_used_twice(self, client, seed_tag, seed_user, tap_session):
        seed_tag(tag_id="EQ-SES-0004", equipment_name="수액펌프-104", nfc_token="pump-104")
        _, headers = seed_user(username="nurse-ses-4")
        session = tap_session("pump-104", headers)

        first = client.post("/usage/checkout", json={"nfc_token": "pump-104", "tap_session": session}, headers=headers)
        second = client.post("/usage/return", json={"nfc_token": "pump-104", "tap_session": session}, headers=headers)

        assert first.status_code == 200
        assert second.status_code == 403

    def test_another_users_session_is_rejected(self, client, seed_tag, seed_user, tap_session):
        """탭한 사람만 그 탭으로 행동할 수 있다."""
        seed_tag(tag_id="EQ-SES-0005", equipment_name="수액펌프-105", nfc_token="pump-105")
        _, tapper_headers = seed_user(username="nurse-ses-5a")
        _, other_headers = seed_user(username="nurse-ses-5b")
        session = tap_session("pump-105", tapper_headers)

        response = client.post(
            "/usage/checkout", json={"nfc_token": "pump-105", "tap_session": session}, headers=other_headers
        )

        assert response.status_code == 403

    def test_a_session_for_another_tag_is_rejected(self, client, seed_tag, seed_user, tap_session):
        seed_tag(tag_id="EQ-SES-0006", equipment_name="수액펌프-106", nfc_token="pump-106")
        seed_tag(tag_id="EQ-SES-0007", equipment_name="수액펌프-107", nfc_token="pump-107")
        _, headers = seed_user(username="nurse-ses-6")
        session = tap_session("pump-106", headers)

        response = client.post(
            "/usage/checkout", json={"nfc_token": "pump-107", "tap_session": session}, headers=headers
        )

        assert response.status_code == 403

    def test_an_expired_session_is_rejected(self, client, db_conn, seed_tag, seed_user, tap_session):
        seed_tag(tag_id="EQ-SES-0008", equipment_name="수액펌프-108", nfc_token="pump-108")
        _, headers = seed_user(username="nurse-ses-8")
        session = tap_session("pump-108", headers)
        with db_conn.cursor() as cur:
            cur.execute("UPDATE nfc_tap_sessions SET expires_at = now() - interval '1 second'")
        db_conn.commit()

        response = client.post(
            "/usage/checkout", json={"nfc_token": "pump-108", "tap_session": session}, headers=headers
        )

        assert response.status_code == 403

    def test_a_failed_action_leaves_the_session_usable(self, client, seed_tag, seed_user, tap_session):
        """이미 대여 중이라 409가 나면 세션은 소비되지 않아야 한다 — 다시 태그를 찾아가지 않도록."""
        seed_tag(tag_id="EQ-SES-0009", equipment_name="수액펌프-109", nfc_token="pump-109")
        _, borrower_headers = seed_user(username="nurse-ses-9a")
        _, headers = seed_user(username="nurse-ses-9b")
        client.post(
            "/usage/checkout",
            json={"nfc_token": "pump-109", "tap_session": tap_session("pump-109", borrower_headers)},
            headers=borrower_headers,
        )
        session = tap_session("pump-109", headers)

        conflict = client.post(
            "/usage/checkout", json={"nfc_token": "pump-109", "tap_session": session}, headers=headers
        )
        retried = client.post("/usage/return", json={"nfc_token": "pump-109", "tap_session": session}, headers=headers)

        assert conflict.status_code == 409
        assert retried.status_code == 200

    def test_a_session_survives_a_backend_restart(self, client, seed_tag, seed_user, tap_session):
        """세션은 프로세스 메모리가 아니라 Postgres에 있다."""
        seed_tag(tag_id="EQ-SES-0010", equipment_name="수액펌프-110", nfc_token="pump-110")
        _, headers = seed_user(username="nurse-ses-10")
        session = tap_session("pump-110", headers)

        with psycopg.connect(TEST_DATABASE_URL) as conn, conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM nfc_tap_sessions WHERE session_id = %s", (session,))
            assert cur.fetchone()[0] == 1


class TestSimulationExemption:
    def test_a_simulated_tag_checks_out_without_any_session(self, client, seed_tag, seed_user):
        """시뮬레이터는 물리 태그가 없다 — 지금까지처럼 토큰만으로 통과해야 한다."""
        seed_tag(tag_id="EQ-SIM-0001", equipment_name="주사기펌프-050", nfc_token="syringe-050", is_real_hardware=False)
        _, headers = seed_user(username="nurse-sim-1")

        checkout = client.post("/usage/checkout", json={"nfc_token": "syringe-050"}, headers=headers)
        returned = client.post("/usage/return", json={"nfc_token": "syringe-050"}, headers=headers)

        assert checkout.status_code == 200
        assert returned.status_code == 200

    def test_a_real_tag_cannot_borrow_the_simulation_exemption(self, client, seed_tag, seed_user):
        """면제 기준은 오직 is_real_hardware다 — 역할이나 계정으로 우회할 수 없다."""
        seed_tag(tag_id="EQ-SIM-0002", equipment_name="수액펌프-201", nfc_token="pump-201")
        _, admin_headers = seed_user(username="admin-sim", role="admin")

        response = client.post("/usage/checkout", json={"nfc_token": "pump-201"}, headers=admin_headers)

        assert response.status_code == 403


class TestMasterKeyAbsent:
    def test_real_hardware_fails_closed_but_simulation_keeps_running(
        self, client, seed_tag, seed_user, bind_ntag, monkeypatch
    ):
        seed_tag(tag_id="EQ-KEY-0001", equipment_name="수액펌프-301", nfc_token="pump-301")
        seed_tag(tag_id="EQ-KEY-0002", equipment_name="주사기펌프-060", nfc_token="syringe-060", is_real_hardware=False)
        uid = bind_ntag("pump-301")
        _, headers = seed_user(username="nurse-key-1")
        monkeypatch.setattr("backend.nfc_tap.NTAG_MASTER_KEY", None)

        tap = client.get("/nfc/pump-301", params=make_sdm_query(uid, 1), headers=headers)
        real_checkout = client.post("/usage/checkout", json={"nfc_token": "pump-301"}, headers=headers)
        sim_checkout = client.post("/usage/checkout", json={"nfc_token": "syringe-060"}, headers=headers)

        assert tap.status_code == 503
        assert real_checkout.status_code == 503
        assert sim_checkout.status_code == 200


class TestBindingLifecycle:
    def test_new_admin_cannot_change_chip_binding(self, client, seed_tag, seed_user, db_conn):
        seed_tag(tag_id="EQ-BIND-NEW", nfc_token="pump-777")
        _, headers = seed_user(username="new-chip-admin", role="admin")

        bind = client.post(
            "/admin/ntag-bindings",
            json={"tag_id": "EQ-BIND-NEW", "ntag_uid": "04AABBCCDDEE99"},
            headers=headers,
        )
        unbind = client.delete("/admin/ntag-bindings/EQ-BIND-NEW", headers=headers)

        assert bind.status_code == 403
        assert unbind.status_code == 403
        with db_conn.cursor() as cur:
            cur.execute("SELECT ntag_uid, ntag_bound FROM tags WHERE tag_id = 'EQ-BIND-NEW'")
            assert cur.fetchone() == (None, False)

    def test_unbinding_keeps_the_counter_so_old_urls_stay_dead(self, client, db_conn, seed_tag, seed_user, bind_ntag):
        """언바인딩이 카운터를 0으로 되돌리면, 그 전에 캡처된 URL이 전부 되살아난다."""
        seed_tag(tag_id="EQ-BIND-0001", equipment_name="수액펌프-401", nfc_token="pump-401")
        uid = bind_ntag("pump-401")
        _, admin_headers = seed_user(username="admin-bind-1", role="admin", can_manage_nfc=True)
        captured = make_sdm_query(uid, 5)
        client.get("/nfc/pump-401", params=captured, headers=admin_headers)

        unbind = client.delete("/admin/ntag-bindings/EQ-BIND-0001", headers=admin_headers)
        with db_conn.cursor() as cur:
            cur.execute("SELECT ntag_uid, ntag_bound, ntag_last_ctr FROM tags WHERE tag_id = %s", ("EQ-BIND-0001",))
            stored_uid, bound, last_ctr = cur.fetchone()
        db_conn.commit()

        assert unbind.status_code == 200
        assert stored_uid == uid
        assert bound is False
        assert last_ctr == 5

    def test_a_uid_cannot_be_rebound_to_other_equipment(self, client, seed_tag, seed_user, bind_ntag):
        seed_tag(tag_id="EQ-BIND-0002", equipment_name="수액펌프-402", nfc_token="pump-402")
        seed_tag(tag_id="EQ-BIND-0003", equipment_name="제세동기-402", nfc_token="defib-402")
        uid = bind_ntag("pump-402")
        _, admin_headers = seed_user(username="admin-bind-2", role="admin", can_manage_nfc=True)
        client.delete("/admin/ntag-bindings/EQ-BIND-0002", headers=admin_headers)

        response = client.post(
            "/admin/ntag-bindings", json={"tag_id": "EQ-BIND-0003", "ntag_uid": uid}, headers=admin_headers
        )

        assert response.status_code == 409

    def test_binding_returns_the_equipment_token_so_the_tool_never_guesses_it(self, client, seed_tag, seed_user):
        """도구가 토큰을 인자로 받으면 오타 하나로 영영 못 쓰는 태그가 구워진다.

        UID와 토큰이 서로 다른 장비를 가리키면 교차검증(R-3)이 항상 실패하는데,
        그 사실은 비가역인 키 회전이 끝난 뒤에야 드러난다.
        """
        seed_tag(tag_id="EQ-BIND-0005", equipment_name="수액펌프-404", nfc_token="pump-404")
        _, admin_headers = seed_user(username="admin-bind-4", role="admin", can_manage_nfc=True)

        response = client.post(
            "/admin/ntag-bindings",
            json={"tag_id": "EQ-BIND-0005", "ntag_uid": "04AABBCCDDEE99"},
            headers=admin_headers,
        )

        assert response.status_code == 200
        assert response.json()["nfc_token"] == "pump-404"

    def test_binding_reports_the_counter_so_the_tool_can_gate_key_rotation(
        self, client, seed_tag, seed_user, bind_ntag
    ):
        """카운터가 0보다 크면 서버가 검증에 성공한 탭이 최소 한 번 있었다는 뜻이다.

        SDM이 켜졌다는 사실만으로는 그 태그가 만든 URL이 실제로 통과하는지 알 수 없다.
        비가역인 키 회전을 걸어도 되는지 판단하려면 이 신호가 필요하다.
        """
        seed_tag(tag_id="EQ-BIND-0007", equipment_name="수액펌프-405", nfc_token="pump-405")
        uid = bind_ntag("pump-405")
        _, admin_headers = seed_user(username="admin-bind-6", role="admin", can_manage_nfc=True)
        _, staff_headers = seed_user(username="staff-bind-6")

        before = client.post(
            "/admin/ntag-bindings", json={"tag_id": "EQ-BIND-0007", "ntag_uid": uid}, headers=admin_headers
        )
        client.get("/nfc/pump-405", params=make_sdm_query(uid, 3), headers=staff_headers)
        after = client.post(
            "/admin/ntag-bindings", json={"tag_id": "EQ-BIND-0007", "ntag_uid": uid}, headers=admin_headers
        )

        assert before.json()["ntag_last_ctr"] == 0
        assert after.json()["ntag_last_ctr"] == 3

    def test_binding_is_refused_when_the_equipment_has_no_token(self, client, seed_tag, seed_user):
        """토큰이 없으면 태그에 구울 URL을 만들 수 없다 — 굽기 전에 막는다."""
        seed_tag(tag_id="EQ-BIND-0006", equipment_name="토큰없는장비", nfc_token=None)
        _, admin_headers = seed_user(username="admin-bind-5", role="admin", can_manage_nfc=True)

        response = client.post(
            "/admin/ntag-bindings",
            json={"tag_id": "EQ-BIND-0006", "ntag_uid": "04AABBCCDDEE98"},
            headers=admin_headers,
        )

        assert response.status_code == 400

    def test_binding_the_same_pair_again_is_idempotent(self, client, seed_tag, seed_user, bind_ntag):
        """개인화 도구가 중간에 실패한 뒤 재실행해도 안전해야 한다."""
        seed_tag(tag_id="EQ-BIND-0004", equipment_name="수액펌프-403", nfc_token="pump-403")
        uid = bind_ntag("pump-403")
        _, admin_headers = seed_user(username="admin-bind-3", role="admin", can_manage_nfc=True)

        response = client.post(
            "/admin/ntag-bindings", json={"tag_id": "EQ-BIND-0004", "ntag_uid": uid}, headers=admin_headers
        )

        assert response.status_code == 200
