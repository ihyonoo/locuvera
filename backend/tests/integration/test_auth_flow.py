"""/auth/register, /auth/login 통합 테스트.

실제 이메일 발송(SMTP)은 register 성공 경로에서 항상 호출되므로,
테스트 중 진짜 메일이 나가지 않도록 매 테스트에서 발송 함수를 무력화한다.
"""

import pytest

from backend import google_oauth
from backend.auth_tokens import create_action_token
from backend.auth_utils import pwd


@pytest.fixture(autouse=True)
def _no_real_email(monkeypatch):
    monkeypatch.setattr("backend.server._send_verification_email_for", lambda *a, **k: None)


def _register(client, **overrides):
    body = {
        "username": "newstaff",
        "display_name": "새 직원",
        "password": "Str0ng!Passw0rd",
        "email": "newstaff@example.com",
        "position": "간호사",
        "role": "staff",
    }
    body.update(overrides)
    return client.post("/auth/register", json=body)


class TestRegister:
    def test_register_staff_success(self, client, db_conn):
        response = _register(client)

        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is True
        assert body["user"]["username"] == "newstaff"
        assert body["user"]["role"] == "staff"

        with db_conn.cursor() as cur:
            cur.execute(
                "SELECT email_verified, password_hash FROM users WHERE username = %s",
                ("newstaff",),
            )
            email_verified, password_hash = cur.fetchone()
        assert email_verified is False
        assert pwd.verify("Str0ng!Passw0rd", password_hash)

    def test_register_admin_success_ignores_position(self, client, db_conn):
        response = _register(
            client, username="newadmin", email="newadmin@example.com", role="admin", position="무시될값"
        )

        assert response.status_code == 200
        assert response.json()["user"]["can_manage_nfc"] is False
        with db_conn.cursor() as cur:
            cur.execute("SELECT position, can_manage_nfc FROM users WHERE username = %s", ("newadmin",))
            position, can_manage_nfc = cur.fetchone()
        assert position is None
        assert can_manage_nfc is False

    def test_register_rejects_duplicate_username(self, client, seed_user):
        seed_user(username="newstaff")

        response = _register(client, email="other@example.com")

        assert response.status_code == 409

    def test_register_rejects_duplicate_email(self, client, seed_user):
        seed_user(username="someoneelse", email="newstaff@example.com")

        response = _register(client)

        assert response.status_code == 409

    def test_register_rejects_invalid_role(self, client):
        response = _register(client, role="superuser")

        assert response.status_code == 400

    def test_register_rejects_staff_without_position(self, client):
        response = _register(client, position=None)

        assert response.status_code == 400

    def test_register_rejects_weak_password(self, client):
        response = _register(client, password="123")

        assert response.status_code == 400


class TestLogin:
    def test_login_success(self, client, seed_user):
        seed_user(username="loginuser", password="Str0ng!Passw0rd", role="staff")

        response = client.post(
            "/auth/login", json={"username": "loginuser", "password": "Str0ng!Passw0rd", "role": "staff"}
        )

        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is True
        assert body["token"]
        assert body["user"]["username"] == "loginuser"

    def test_login_rejects_unknown_username(self, client):
        response = client.post("/auth/login", json={"username": "ghost", "password": "whatever", "role": "staff"})

        assert response.status_code == 401

    def test_login_rejects_wrong_password(self, client, seed_user):
        seed_user(username="loginuser", password="Str0ng!Passw0rd", role="staff")

        response = client.post(
            "/auth/login", json={"username": "loginuser", "password": "wrong-password", "role": "staff"}
        )

        assert response.status_code == 401

    def test_login_rejects_inactive_account(self, client, seed_user):
        seed_user(username="loginuser", password="Str0ng!Passw0rd", role="staff", is_active=False)

        response = client.post(
            "/auth/login", json={"username": "loginuser", "password": "Str0ng!Passw0rd", "role": "staff"}
        )

        assert response.status_code == 403

    def test_login_rejects_unverified_email(self, client, seed_user):
        seed_user(username="loginuser", password="Str0ng!Passw0rd", role="staff", email_verified=False)

        response = client.post(
            "/auth/login", json={"username": "loginuser", "password": "Str0ng!Passw0rd", "role": "staff"}
        )

        assert response.status_code == 403
        assert response.json()["detail"]["code"] == "email_unverified"

    def test_login_rejects_role_mismatch(self, client, seed_user):
        seed_user(username="loginuser", password="Str0ng!Passw0rd", role="staff")

        response = client.post(
            "/auth/login", json={"username": "loginuser", "password": "Str0ng!Passw0rd", "role": "admin"}
        )

        assert response.status_code == 403


def test_google_callback_rejects_unverified_email_before_account_link(client, seed_user, db_conn, monkeypatch):
    seed_user(username="linked_user", email="linked@example.com")
    monkeypatch.setattr(
        google_oauth,
        "exchange_code",
        lambda _code: {
            "sub": "google-123",
            "email": "linked@example.com",
            "email_verified": False,
            "name": "Linked User",
        },
    )

    response = client.get(
        "/auth/google/callback",
        params={"code": "code", "state": google_oauth.sign_state("login")},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert "oauth_error=" in response.headers["location"]
    with db_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM user_oauth_identities")
        assert cur.fetchone()[0] == 0


def test_google_complete_rejects_old_pending_unverified_email(client, db_conn):
    pending = create_action_token(
        purpose="oauth_pending",
        ttl_sec=300,
        payload={
            "provider": "google",
            "sub": "google-old",
            "email": "old@example.com",
            "email_verified": False,
            "name": "Old",
        },
    )
    response = client.post(
        "/auth/google/complete",
        json={
            "pending_token": pending,
            "username": "olduser",
            "display_name": "Old",
            "password": "Str0ng!Passw0rd",
            "position": "간호사",
            "role": "staff",
        },
    )
    assert response.status_code == 400
    with db_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM users")
        assert cur.fetchone()[0] == 0
