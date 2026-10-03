import time

import pytest
from fastapi import HTTPException

from backend.auth_utils import (
    build_auth_token,
    decode_auth_token,
    normalize_display_name,
    normalize_email,
    normalize_optional_text,
    normalize_username,
    validate_password,
)


class TestNormalizeUsername:
    def test_trims_and_accepts_valid_username(self):
        assert normalize_username("  hyunwoo.choi  ") == "hyunwoo.choi"

    def test_rejects_empty(self):
        with pytest.raises(HTTPException) as exc:
            normalize_username("   ")
        assert exc.value.status_code == 400

    def test_rejects_too_short(self):
        with pytest.raises(HTTPException):
            normalize_username("ab")

    def test_rejects_forbidden_characters(self):
        with pytest.raises(HTTPException):
            normalize_username("hyun woo!")


class TestNormalizeEmail:
    def test_lowercases_and_trims(self):
        assert normalize_email("  Foo@Example.COM ") == "foo@example.com"

    def test_rejects_missing_at_sign(self):
        with pytest.raises(HTTPException):
            normalize_email("not-an-email")

    def test_rejects_none(self):
        with pytest.raises(HTTPException):
            normalize_email(None)


class TestNormalizeDisplayName:
    def test_rejects_empty(self):
        with pytest.raises(HTTPException):
            normalize_display_name("   ")

    def test_rejects_too_long(self):
        with pytest.raises(HTTPException):
            normalize_display_name("a" * 51)

    def test_accepts_valid_name(self):
        assert normalize_display_name(" 최현우 ") == "최현우"

    @pytest.mark.parametrize("name", ["=1+1", "  +SUM(1)", "\t@cmd", "\n-3"])
    def test_rejects_spreadsheet_formula_prefix(self, name):
        with pytest.raises(HTTPException) as exc:
            normalize_display_name(name)
        assert exc.value.status_code == 400


class TestNormalizeOptionalText:
    def test_none_passes_through(self):
        assert normalize_optional_text(None, "department") is None

    def test_blank_becomes_none(self):
        assert normalize_optional_text("   ", "department") is None

    def test_rejects_too_long(self):
        with pytest.raises(HTTPException):
            normalize_optional_text("a" * 51, "department", max_len=50)


class TestValidatePassword:
    @pytest.mark.parametrize(
        "password",
        [
            "short1!",  # 8자 미만
            "12345678",  # 영문자 없음
            "alllettersnodigit!",  # 숫자 없음
            "NoSpecialChar1",  # 특수문자 없음
        ],
    )
    def test_rejects_weak_passwords(self, password):
        with pytest.raises(HTTPException) as exc:
            validate_password(password)
        assert exc.value.status_code == 400

    def test_accepts_strong_password(self):
        assert validate_password("Passw0rd!") == "Passw0rd!"


class TestAuthToken:
    def test_round_trip(self):
        token, expires_at = build_auth_token(user_id=42, token_version=3)
        payload = decode_auth_token(token)
        assert payload["sub"] == 42
        assert payload["tv"] == 3
        assert payload["exp"] == expires_at

    def test_rejects_tampered_signature(self):
        token, _ = build_auth_token(user_id=1)
        payload_segment, _sig = token.split(".", 1)
        tampered = f"{payload_segment}.tampered"
        with pytest.raises(HTTPException) as exc:
            decode_auth_token(tampered)
        assert exc.value.status_code == 401

    def test_rejects_expired_token(self, monkeypatch):
        token, expires_at = build_auth_token(user_id=1)
        monkeypatch.setattr(time, "time", lambda: expires_at + 1)
        with pytest.raises(HTTPException) as exc:
            decode_auth_token(token)
        assert exc.value.status_code == 401

    def test_rejects_malformed_token(self):
        with pytest.raises(HTTPException):
            decode_auth_token("not-a-valid-token")

    @pytest.mark.parametrize("token", ["한글.x", "e30.한글", "e30.%"])
    def test_rejects_invalid_token_encoding_as_unauthorized(self, token):
        with pytest.raises(HTTPException) as exc:
            decode_auth_token(token)
        assert exc.value.status_code == 401
