import time
from unittest.mock import MagicMock, patch

import pytest
import requests
from fastapi import HTTPException

from backend import google_oauth
from backend.google_oauth import exchange_code, sign_state, verify_state


def _resp(status_code: int, json_data: dict | None = None) -> MagicMock:
    """가짜 requests.Response를 만든다."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    return resp


class TestOAuthState:
    def test_round_trip_defaults_to_login_mode(self):
        state = sign_state("login")
        assert verify_state(state) == ("login", None)

    def test_round_trip_signup_mode(self):
        state = sign_state("signup")
        assert verify_state(state) == ("signup", None)

    def test_rejects_tampered_signature(self):
        state = sign_state("login")
        segment, _sig = state.split(".", 1)
        with pytest.raises(HTTPException) as exc:
            verify_state(f"{segment}.tampered")
        assert exc.value.status_code == 400

    def test_rejects_malformed_state(self):
        with pytest.raises(HTTPException) as exc:
            verify_state("not-a-valid-state")
        assert exc.value.status_code == 400

    def test_rejects_expired_state(self, monkeypatch):
        state = sign_state("login")
        # OAUTH_STATE_TTL_SEC 이후 시각으로 이동시켜 만료를 재현한다.
        future = time.time() + 10_000
        monkeypatch.setattr(time, "time", lambda: future)
        with pytest.raises(HTTPException) as exc:
            verify_state(state)
        assert exc.value.status_code == 400


class TestExchangeCode:
    TOKEN_OK = _resp(200, {"access_token": "fake-access-token"})
    USERINFO_OK = _resp(
        200,
        {
            "sub": "1234567890",
            "email": "User@Example.com",
            "email_verified": True,
            "name": "홍길동",
        },
    )

    def test_success_returns_parsed_userinfo(self):
        with (
            patch("backend.google_oauth.requests.post", return_value=self.TOKEN_OK) as mock_post,
            patch("backend.google_oauth.requests.get", return_value=self.USERINFO_OK) as mock_get,
        ):
            result = exchange_code("auth-code")

        assert result == {
            "sub": "1234567890",
            "email": "user@example.com",  # 소문자로 정규화된다.
            "email_verified": True,
            "name": "홍길동",
        }
        mock_post.assert_called_once()
        mock_get.assert_called_once()
        # access token이 Authorization 헤더로 전달되는지 확인한다.
        assert mock_get.call_args.kwargs["headers"] == {"Authorization": "Bearer fake-access-token"}

    def test_token_exchange_network_error_raises_502(self):
        with (
            patch("backend.google_oauth.requests.post", side_effect=requests.RequestException("boom")),
            pytest.raises(HTTPException) as exc,
        ):
            exchange_code("auth-code")
        assert exc.value.status_code == 502

    def test_token_exchange_non_200_raises_401(self):
        with (
            patch("backend.google_oauth.requests.post", return_value=_resp(400, {"error": "invalid_grant"})),
            pytest.raises(HTTPException) as exc,
        ):
            exchange_code("auth-code")
        assert exc.value.status_code == 401

    def test_token_exchange_missing_access_token_raises_401(self):
        with (
            patch("backend.google_oauth.requests.post", return_value=_resp(200, {})),
            pytest.raises(HTTPException) as exc,
        ):
            exchange_code("auth-code")
        assert exc.value.status_code == 401

    def test_userinfo_network_error_raises_502(self):
        with (
            patch("backend.google_oauth.requests.post", return_value=self.TOKEN_OK),
            patch("backend.google_oauth.requests.get", side_effect=requests.RequestException("boom")),
            pytest.raises(HTTPException) as exc,
        ):
            exchange_code("auth-code")
        assert exc.value.status_code == 502

    def test_userinfo_non_200_raises_401(self):
        with (
            patch("backend.google_oauth.requests.post", return_value=self.TOKEN_OK),
            patch("backend.google_oauth.requests.get", return_value=_resp(403, {})),
            pytest.raises(HTTPException) as exc,
        ):
            exchange_code("auth-code")
        assert exc.value.status_code == 401

    def test_userinfo_missing_sub_raises_401(self):
        missing_sub = _resp(200, {"email": "user@example.com", "email_verified": True})
        with (
            patch("backend.google_oauth.requests.post", return_value=self.TOKEN_OK),
            patch("backend.google_oauth.requests.get", return_value=missing_sub),
            pytest.raises(HTTPException) as exc,
        ):
            exchange_code("auth-code")
        assert exc.value.status_code == 401

    def test_userinfo_missing_email_raises_401(self):
        missing_email = _resp(200, {"sub": "1234567890", "email_verified": True})
        with (
            patch("backend.google_oauth.requests.post", return_value=self.TOKEN_OK),
            patch("backend.google_oauth.requests.get", return_value=missing_email),
            pytest.raises(HTTPException) as exc,
        ):
            exchange_code("auth-code")
        assert exc.value.status_code == 401

    def test_defaults_email_verified_false_and_name_empty_when_absent(self):
        # email_verified/name 필드가 응답에 없으면 각각 False/빈 문자열로 기본값 처리된다.
        no_optional_fields = _resp(200, {"sub": "1234567890", "email": "user@example.com"})
        with (
            patch("backend.google_oauth.requests.post", return_value=self.TOKEN_OK),
            patch("backend.google_oauth.requests.get", return_value=no_optional_fields),
        ):
            result = exchange_code("auth-code")
        assert result["email_verified"] is False
        assert result["name"] == ""

    def test_string_false_is_not_a_verified_email(self):
        response = _resp(200, {"sub": "123", "email": "user@example.com", "email_verified": "false"})
        with (
            patch("backend.google_oauth.requests.post", return_value=self.TOKEN_OK),
            patch("backend.google_oauth.requests.get", return_value=response),
        ):
            result = exchange_code("auth-code")
        assert result["email_verified"] is False


class TestRedirectInState:
    """구글 왕복 중 '원래 가려던 곳'을 잃지 않아야 한다.

    NFC 태그를 태깅해 /nfc/{token}으로 들어온 사람이 구글로 로그인하면, 돌아왔을 때
    대여 화면이어야 한다. 그 값을 나를 곳이 state뿐이라 여기에 실어 보낸다.
    """

    def test_round_trips_the_redirect_target(self):
        state = google_oauth.sign_state("login", "/nfc/pump-001?uid=04AABB&ctr=000001&cmac=00112233")

        mode, redirect = google_oauth.verify_state(state)

        assert mode == "login"
        assert redirect == "/nfc/pump-001?uid=04AABB&ctr=000001&cmac=00112233"

    def test_redirect_is_optional(self):
        mode, redirect = google_oauth.verify_state(google_oauth.sign_state("signup"))

        assert mode == "signup"
        assert redirect is None

    def test_the_signature_covers_the_redirect(self):
        """서명이 redirect까지 덮지 않으면, 공격자가 목적지만 바꿔치기해 로그인 직후 원하는
        화면으로 끌고 갈 수 있다. payload를 고쳐 서명을 그대로 붙이면 거부돼야 한다."""
        import base64
        import json

        state = google_oauth.sign_state("login", "/nfc/pump-001")
        segment, signature = state.split(".", 1)
        payload = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
        payload["redirect"] = "/admin/nfc-mapping"
        forged = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")

        with pytest.raises(HTTPException):
            google_oauth.verify_state(f"{forged}.{signature}")


class TestSafeRedirectPath:
    """redirect를 그대로 믿으면 오픈 리다이렉트가 된다.

    공격자가 로그인 링크에 외부 주소를 심어두면, 사용자는 우리 도메인에서 로그인한 뒤
    남의 사이트로 떨어진다. 같은 사이트 경로만 통과시킨다.
    """

    @pytest.mark.parametrize(
        "path",
        ["/", "/nfc/pump-001", "/nfc/pump-001?uid=04AABB&cmac=00", "/admin/nfc-mapping"],
    )
    def test_accepts_same_site_paths(self, path):
        assert google_oauth.safe_redirect_path(path) == path

    @pytest.mark.parametrize(
        "path",
        [
            "https://evil.example.com/steal",
            "http://evil.example.com",
            "//evil.example.com",  # 프로토콜 상대 URL
            "/\\evil.example.com",  # 백슬래시 우회
            "javascript:alert(1)",
            "nfc/pump-001",  # 슬래시로 시작하지 않음
            "",
            None,
        ],
    )
    def test_rejects_anything_that_could_leave_the_site(self, path):
        assert google_oauth.safe_redirect_path(path) is None
