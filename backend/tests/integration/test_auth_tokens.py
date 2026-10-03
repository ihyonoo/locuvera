"""auth_tokens.py의 일회성 액션 토큰(이메일 인증/비밀번호 재설정 등) 발급·소비 테스트.

해시만 DB(auth_action_tokens)에 저장되고 원문은 반환값에만 존재하는 패턴,
그리고 일회성(재사용 불가)·만료 처리를 실제 테스트 DB로 검증한다.
"""

from backend.auth_tokens import consume_action_token, create_action_token


def test_reset_failure_does_not_consume_one_time_token(client, seed_user, monkeypatch):
    user_id, _ = seed_user(username="reset_retry", email="reset@example.com")
    token = create_action_token(purpose="password_reset", ttl_sec=3600, user_id=user_id)
    from backend import server

    original_hash = server.pwd.hash
    monkeypatch.setattr(server.pwd, "hash", lambda _value: (_ for _ in ()).throw(RuntimeError("hash failed")))
    try:
        response = client.post("/auth/reset-password", json={"token": token, "password": "Str0ng!Passw0rd"})
    except RuntimeError:
        pass
    else:
        assert response.status_code == 500
    finally:
        monkeypatch.setattr(server.pwd, "hash", original_hash)

    retry = client.post("/auth/reset-password", json={"token": token, "password": "Str0ng!Passw0rd"})
    assert retry.status_code == 200


def test_google_complete_validation_failure_keeps_pending_token(client):
    pending = create_action_token(
        purpose="oauth_pending",
        ttl_sec=300,
        payload={
            "provider": "google",
            "sub": "retry-google",
            "email": "retry@example.com",
            "email_verified": True,
            "name": "Retry",
        },
    )
    body = {
        "pending_token": pending,
        "username": "bad user",
        "display_name": "Retry",
        "password": "Str0ng!Passw0rd",
        "position": "간호사",
        "role": "staff",
    }

    assert client.post("/auth/google/complete", json=body).status_code == 400
    assert client.post("/auth/google/complete", json={**body, "username": "retryuser"}).status_code == 200


def test_session_exchange_failure_keeps_handoff_token(client, seed_user, monkeypatch):
    user_id, _ = seed_user(username="handoff_retry")
    token = create_action_token(purpose="oauth_handoff", ttl_sec=300, user_id=user_id)
    from backend import server

    original_issue = server._issue_session_for_user
    monkeypatch.setattr(
        server, "_issue_session_for_user", lambda _user_id, **_kwargs: (_ for _ in ()).throw(RuntimeError())
    )
    try:
        client.post("/auth/session/exchange", json={"code": token})
    except RuntimeError:
        pass
    finally:
        monkeypatch.setattr(server, "_issue_session_for_user", original_issue)

    assert client.post("/auth/session/exchange", json={"code": token}).status_code == 200


class TestActionTokenRoundTrip:
    def test_consume_returns_payload_for_valid_token(self, seed_user):
        user_id, _headers = seed_user()
        raw_token = create_action_token(purpose="email_verify", ttl_sec=3600, user_id=user_id, payload={"foo": "bar"})

        result = consume_action_token(raw_token, "email_verify")

        assert result is not None
        assert result["user_id"] == user_id
        assert result["payload"] == {"foo": "bar"}

    def test_token_can_only_be_consumed_once(self):
        # user_id는 oauth_handoff/pending처럼 NULL 허용 — FK 없이도 재사용 방지 로직만 검증하면 된다.
        raw_token = create_action_token(purpose="password_reset", ttl_sec=3600, user_id=None)

        first = consume_action_token(raw_token, "password_reset")
        second = consume_action_token(raw_token, "password_reset")

        assert first is not None
        assert second is None

    def test_rejects_wrong_purpose(self):
        raw_token = create_action_token(purpose="email_verify", ttl_sec=3600, user_id=None)

        result = consume_action_token(raw_token, "password_reset")

        assert result is None

    def test_rejects_expired_token(self):
        raw_token = create_action_token(purpose="email_verify", ttl_sec=-1, user_id=None)

        result = consume_action_token(raw_token, "email_verify")

        assert result is None

    def test_rejects_unknown_token(self):
        assert consume_action_token("not-a-real-token", "email_verify") is None

    def test_rejects_empty_token(self):
        assert consume_action_token("", "email_verify") is None
