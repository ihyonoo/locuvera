"""가입 요청(/auth/signup-requests)과 관리자 승인·거절(/admin/signup-requests) 통합 테스트.

공개 가입은 요청만 남기고, 관리자가 승인할 때 계정을 만들어 비밀번호 설정 링크를 메일로 보낸다.
설정 메일은 발송 함수를 가로채 링크를 꺼내 쓴다(실제 SMTP 발송 없음).
"""

import urllib.parse

import pytest


@pytest.fixture
def sent_setup_emails(monkeypatch):
    sent = []
    monkeypatch.setattr(
        "backend.server.send_account_setup_email",
        lambda to, username, role, link: sent.append({"to": to, "username": username, "role": role, "link": link}),
    )
    return sent


@pytest.fixture
def admin_headers(seed_user):
    _user_id, headers = seed_user(username="admin1", role="admin", position=None)
    return headers


def _request(client, **overrides):
    body = {"employee_no": "20261031", "display_name": "새 직원", "email": "new@example.com"}
    body.update(overrides)
    return client.post("/auth/signup-requests", json=body)


def _only_request_id(client, headers):
    items = client.get("/admin/signup-requests", headers=headers).json()["items"]
    assert len(items) == 1
    return items[0]["request_id"]


def _approve(client, headers, request_id, **overrides):
    body = {"role": "staff", "department": "내과", "position": "간호사"}
    body.update(overrides)
    return client.post(f"/admin/signup-requests/{request_id}/approve", json=body, headers=headers)


def _token_from_link(link: str) -> str:
    return urllib.parse.parse_qs(urllib.parse.urlparse(link).query)["token"][0]


def _token_lifetime_sec(db_conn) -> float:
    # created_at은 DB 시계, expires_at은 백엔드 시계라 몇 초 오차를 허용한다.
    return _count(
        db_conn,
        "SELECT EXTRACT(EPOCH FROM expires_at - created_at)::float FROM auth_action_tokens "
        "WHERE purpose = 'password_reset'",
    )


def _count(db_conn, sql, params=()):
    with db_conn.cursor() as cur:
        cur.execute(sql, params)
        value = cur.fetchone()[0]
    db_conn.commit()
    return value


class TestCreateSignupRequest:
    def test_stores_request_without_creating_account(self, client, db_conn):
        response = _request(client)

        assert response.status_code == 200
        assert response.json()["ok"] is True
        assert _count(db_conn, "SELECT count(*) FROM signup_requests WHERE employee_no = '20261031'") == 1
        assert _count(db_conn, "SELECT count(*) FROM users") == 0

    def test_trims_employee_no_and_normalizes_email(self, client, db_conn):
        response = _request(client, employee_no=" 20261031 ", email=" New@Example.COM ")

        assert response.status_code == 200
        with db_conn.cursor() as cur:
            cur.execute("SELECT employee_no, email FROM signup_requests")
            assert cur.fetchone() == ("20261031", "new@example.com")

    @pytest.mark.parametrize("employee_no", ["2026103", "202610311", "2026103a", "abcdefgh", ""])
    def test_rejects_employee_no_that_is_not_eight_digits(self, client, employee_no):
        assert _request(client, employee_no=employee_no).status_code == 400

    def test_rejects_invalid_email(self, client):
        assert _request(client, email="not-an-email").status_code == 400

    def test_rejects_blank_name(self, client):
        assert _request(client, display_name="   ").status_code == 400

    def test_rejects_employee_no_of_existing_account(self, client, seed_user):
        seed_user(username="20261031", email="someone@example.com")

        response = _request(client)

        assert response.status_code == 409
        assert response.json()["detail"] == "이미 가입되었거나 요청 중인 사번입니다."

    def test_rejects_email_of_existing_account(self, client, seed_user):
        seed_user(username="someone", email="new@example.com")

        response = _request(client)

        assert response.status_code == 409
        assert response.json()["detail"] == "이미 가입되었거나 요청 중인 이메일입니다."

    def test_rejects_employee_no_already_requested(self, client):
        _request(client)

        response = _request(client, email="other@example.com")

        assert response.status_code == 409
        assert response.json()["detail"] == "이미 가입되었거나 요청 중인 사번입니다."

    def test_rejects_email_already_requested(self, client):
        _request(client)

        response = _request(client, employee_no="20261032")

        assert response.status_code == 409
        assert response.json()["detail"] == "이미 가입되었거나 요청 중인 이메일입니다."

    def test_self_registration_endpoint_is_gone(self, client):
        response = client.post(
            "/auth/register",
            json={
                "username": "selfadmin",
                "display_name": "자가 가입",
                "password": "Str0ng!Passw0rd",
                "email": "self@example.com",
                "role": "admin",
            },
        )

        assert response.status_code in (404, 405)


class TestListSignupRequests:
    def test_lists_pending_requests_oldest_first(self, client, admin_headers):
        _request(client)
        _request(client, employee_no="20261032", display_name="두번째", email="second@example.com")

        response = client.get("/admin/signup-requests", headers=admin_headers)

        assert response.status_code == 200
        body = response.json()
        assert body["count"] == 2
        assert [item["employee_no"] for item in body["items"]] == ["20261031", "20261032"]
        first = body["items"][0]
        assert first["display_name"] == "새 직원"
        assert first["email"] == "new@example.com"
        assert first["created_at"]

    def test_requires_login(self, client):
        assert client.get("/admin/signup-requests").status_code == 401

    def test_rejects_staff(self, client, seed_user):
        _user_id, headers = seed_user(username="nurse", role="staff")

        assert client.get("/admin/signup-requests", headers=headers).status_code == 403

    def test_rejects_demo_admin(self, client, seed_user):
        _user_id, headers = seed_user(username="demo-admin", role="admin", position=None, is_demo=True)

        assert client.get("/admin/signup-requests", headers=headers).status_code == 403


class TestApproveSignupRequest:
    def test_creates_account_without_password_and_removes_request(
        self, client, db_conn, admin_headers, sent_setup_emails
    ):
        _request(client)
        request_id = _only_request_id(client, admin_headers)

        response = _approve(client, admin_headers, request_id)

        assert response.status_code == 200
        with db_conn.cursor() as cur:
            cur.execute(
                """
                SELECT display_name, email, role, department, position, password_hash,
                       email_verified, is_active, can_manage_nfc
                FROM users WHERE username = '20261031'
                """
            )
            row = cur.fetchone()
        db_conn.commit()
        assert row == ("새 직원", "new@example.com", "staff", "내과", "간호사", None, False, True, False)
        assert _count(db_conn, "SELECT count(*) FROM signup_requests") == 0

    def test_sends_setup_link_with_employee_no_and_role(self, client, admin_headers, sent_setup_emails):
        _request(client)
        _approve(client, admin_headers, _only_request_id(client, admin_headers))

        assert len(sent_setup_emails) == 1
        mail = sent_setup_emails[0]
        assert mail["to"] == "new@example.com"
        assert mail["username"] == "20261031"
        assert mail["role"] == "staff"
        assert "/reset-password?token=" in mail["link"]

    def test_setup_link_sets_password_verifies_email_and_allows_login(
        self, client, db_conn, admin_headers, sent_setup_emails
    ):
        _request(client)
        _approve(client, admin_headers, _only_request_id(client, admin_headers))
        token = _token_from_link(sent_setup_emails[0]["link"])

        reset = client.post("/auth/reset-password", json={"token": token, "password": "Str0ng!Passw0rd"})
        login = client.post(
            "/auth/login", json={"username": "20261031", "password": "Str0ng!Passw0rd", "role": "staff"}
        )

        assert reset.status_code == 200
        assert login.status_code == 200
        assert _count(db_conn, "SELECT email_verified::int FROM users WHERE username = '20261031'") == 1

    def test_setup_link_is_valid_for_72_hours(self, client, db_conn, admin_headers, sent_setup_emails):
        _request(client)
        _approve(client, admin_headers, _only_request_id(client, admin_headers))

        assert _token_lifetime_sec(db_conn) == pytest.approx(72 * 3600, abs=60)

    def test_login_before_setting_password_is_rejected(self, client, admin_headers, sent_setup_emails):
        _request(client)
        _approve(client, admin_headers, _only_request_id(client, admin_headers))

        response = client.post("/auth/login", json={"username": "20261031", "password": "anything", "role": "staff"})

        assert response.status_code == 401

    def test_admin_role_ignores_department_and_position(self, client, db_conn, admin_headers, sent_setup_emails):
        _request(client)

        response = _approve(client, admin_headers, _only_request_id(client, admin_headers), role="admin")

        assert response.status_code == 200
        with db_conn.cursor() as cur:
            cur.execute("SELECT role, department, position FROM users WHERE username = '20261031'")
            assert cur.fetchone() == ("admin", None, None)
        assert sent_setup_emails[0]["role"] == "admin"

    def test_staff_requires_position(self, client, db_conn, admin_headers, sent_setup_emails):
        _request(client)

        response = _approve(client, admin_headers, _only_request_id(client, admin_headers), position=None)

        assert response.status_code == 400
        assert _count(db_conn, "SELECT count(*) FROM signup_requests") == 1
        assert sent_setup_emails == []

    def test_rejects_unknown_role(self, client, admin_headers, sent_setup_emails):
        _request(client)

        response = _approve(client, admin_headers, _only_request_id(client, admin_headers), role="superuser")

        assert response.status_code == 400

    def test_unknown_request_is_404(self, client, admin_headers, sent_setup_emails):
        assert _approve(client, admin_headers, 9999).status_code == 404

    def test_conflict_when_account_appeared_meanwhile_keeps_request(
        self, client, db_conn, admin_headers, seed_user, sent_setup_emails
    ):
        _request(client)
        request_id = _only_request_id(client, admin_headers)
        seed_user(username="20261031", email="elsewhere@example.com")

        response = _approve(client, admin_headers, request_id)

        assert response.status_code == 409
        assert _count(db_conn, "SELECT count(*) FROM signup_requests") == 1
        assert sent_setup_emails == []

    def test_rejects_demo_admin_and_keeps_request(self, client, db_conn, seed_user, sent_setup_emails):
        _request(client)
        with db_conn.cursor() as cur:
            cur.execute("SELECT request_id FROM signup_requests")
            request_id = cur.fetchone()[0]
        db_conn.commit()
        _user_id, demo_headers = seed_user(username="demo-admin", role="admin", position=None, is_demo=True)

        response = _approve(client, demo_headers, request_id)

        assert response.status_code == 403
        assert _count(db_conn, "SELECT count(*) FROM signup_requests") == 1


class TestRejectSignupRequest:
    def test_deletes_request_and_allows_new_request(self, client, db_conn, admin_headers):
        _request(client)
        request_id = _only_request_id(client, admin_headers)

        response = client.delete(f"/admin/signup-requests/{request_id}", headers=admin_headers)

        assert response.status_code == 200
        assert _count(db_conn, "SELECT count(*) FROM signup_requests") == 0
        assert _count(db_conn, "SELECT count(*) FROM users WHERE username = '20261031'") == 0
        assert _request(client).status_code == 200

    def test_unknown_request_is_404(self, client, admin_headers):
        assert client.delete("/admin/signup-requests/9999", headers=admin_headers).status_code == 404

    def test_rejects_demo_admin(self, client, db_conn, seed_user):
        _request(client)
        with db_conn.cursor() as cur:
            cur.execute("SELECT request_id FROM signup_requests")
            request_id = cur.fetchone()[0]
        db_conn.commit()
        _user_id, demo_headers = seed_user(username="demo-admin", role="admin", position=None, is_demo=True)

        response = client.delete(f"/admin/signup-requests/{request_id}", headers=demo_headers)

        assert response.status_code == 403
        assert _count(db_conn, "SELECT count(*) FROM signup_requests") == 1


class TestPasswordReset:
    def test_reset_marks_email_verified(self, client, db_conn, seed_user, monkeypatch):
        sent = []
        monkeypatch.setattr("backend.server.send_reset_email", lambda to, link: sent.append(link))
        seed_user(username="unverified", email="unverified@example.com", email_verified=False)
        client.post("/auth/forgot-password", json={"email": "unverified@example.com"})

        response = client.post(
            "/auth/reset-password", json={"token": _token_from_link(sent[0]), "password": "Str0ng!Passw0rd"}
        )

        assert response.status_code == 200
        assert _count(db_conn, "SELECT email_verified::int FROM users WHERE username = 'unverified'") == 1

    def test_forgot_password_link_still_expires_after_one_hour(self, client, db_conn, seed_user, monkeypatch):
        monkeypatch.setattr("backend.server.send_reset_email", lambda to, link: None)
        seed_user(username="forgetful", email="forgetful@example.com")

        client.post("/auth/forgot-password", json={"email": "forgetful@example.com"})

        assert _token_lifetime_sec(db_conn) == pytest.approx(3600, abs=60)
