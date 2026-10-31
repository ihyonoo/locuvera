"""/auth/login과 Google 로그인 통합 테스트."""

import pytest

from backend import google_oauth
from backend.auth_tokens import create_action_token


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


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("get", "/auth/google/start", {}),
        ("get", "/auth/google/callback", {"params": {"code": "code", "state": "state"}}),
        (
            "post",
            "/auth/google/complete",
            {"json": {"pending_token": "t", "username": "someone", "password": "Str0ng!Passw0rd", "role": "staff"}},
        ),
    ],
)
def test_google_login_endpoints_return_404_when_disabled(client, monkeypatch, method, path, kwargs):
    monkeypatch.setattr("backend.server.GOOGLE_LOGIN_ENABLED", False)

    response = getattr(client, method)(path, follow_redirects=False, **kwargs)

    assert response.status_code == 404


def test_google_callback_rejects_unverified_email_before_account_link(client, seed_user, db_conn, monkeypatch):
    monkeypatch.setattr("backend.server.GOOGLE_LOGIN_ENABLED", True)
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


def test_google_complete_rejects_old_pending_unverified_email(client, db_conn, monkeypatch):
    monkeypatch.setattr("backend.server.GOOGLE_LOGIN_ENABLED", True)
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
