"""개인화 절차의 판단 로직. 리더 I/O는 키를 구분하는 가짜 태그로 대신한다."""

import pytest

from tools.ntag.crypto import (
    decrypt_rnd_b,
    encrypt_command_data,
    rotate_left,
)
from tools.ntag.personalise import SDM_FILE_READ_KEY_NO, detect_state
from tools.ntag.tests.test_session import RND_A

FACTORY = bytes(16)
DERIVED = bytes(range(16))
TI = bytes.fromhex("9D00C4DF")
RND_B = bytes.fromhex("B9E2FC789B64BF237CCCAA20EC7E6E48")


class KeyAwareTransport:
    """지정한 키로만 인증이 성립하는 가짜 태그.

    다른 키로 접근하면 챌린지 복호화가 어긋나 RndA가 되돌아오지 않으므로,
    실제 태그와 같은 이유로 인증이 실패한다.
    """

    def __init__(self, accepted_key: bytes):
        self.accepted_key = accepted_key
        self.sent: list[bytes] = []

    def transmit(self, apdu: bytes) -> tuple[bytes, str]:
        self.sent.append(apdu)
        if apdu[:2] == b"\x00\xa4":
            return b"", "9000"
        if apdu[1] == 0x71:
            return encrypt_command_data(self.accepted_key, bytes(16), RND_B, already_padded=True), "91AF"
        if apdu[1] == 0xAF:
            challenge = apdu[5:-1]
            plain = decrypt_rnd_b(self.accepted_key, challenge)
            rnd_a = plain[:16]
            response = TI + rotate_left(rnd_a) + bytes(12)
            return encrypt_command_data(self.accepted_key, bytes(16), response, already_padded=True), "9100"
        return b"", "9100"


@pytest.fixture
def fixed_rnd_a(monkeypatch):
    monkeypatch.setattr("tools.ntag.session.generate_random", lambda n: RND_A[:n])


class TestDetectState:
    def test_probes_the_key_that_actually_gets_rotated(self, fixed_rnd_a):
        """키 0은 공장값 그대로 두므로, 키 0으로 물으면 완성된 태그도 factory로 오판한다."""
        transport = KeyAwareTransport(FACTORY)

        detect_state(transport, tag_key=DERIVED)

        auth_apdus = [a for a in transport.sent if a[1] == 0x71]
        assert auth_apdus, "인증을 시도하지 않았다"
        assert all(a[5] == SDM_FILE_READ_KEY_NO for a in auth_apdus)

    def test_reports_factory_when_the_factory_key_authenticates(self, fixed_rnd_a):
        assert detect_state(KeyAwareTransport(FACTORY), tag_key=DERIVED) == "factory"

    def test_reports_rotated_when_only_the_derived_key_authenticates(self, fixed_rnd_a):
        """공장 키로 먼저 시도해 실패한 뒤 파생 키로 성공하는 경로."""
        assert detect_state(KeyAwareTransport(DERIVED), tag_key=DERIVED) == "rotated"

    def test_reports_unknown_when_neither_key_authenticates(self, fixed_rnd_a):
        assert detect_state(KeyAwareTransport(bytes([0xAA] * 16)), tag_key=DERIVED) == "unknown"

    def test_a_failed_probe_does_not_stop_the_next_one(self, fixed_rnd_a):
        """공장 키 시도가 실패해도 파생 키 시도가 이어져야 한다 — 아니면 rotated를 못 찾는다."""
        transport = KeyAwareTransport(DERIVED)

        detect_state(transport, tag_key=DERIVED)

        assert len([a for a in transport.sent if a[1] == 0x71]) == 2


class TestLoginPayload:
    def test_payload_satisfies_the_server_schema(self):
        """도구가 보내는 로그인 본문이 서버 스키마를 만족해야 한다.

        필드 하나가 빠지면 서버는 422로 거절하는데, 그 사실은 태그를 리더에 올려두고
        비밀번호까지 입력한 뒤에야 드러난다.
        """
        from backend.schemas import LoginRequest
        from tools.ntag.personalise import login_payload

        LoginRequest(**login_payload("admin", "secret"))

    def test_requests_the_admin_role(self):
        """관리자 API를 쓰므로 staff로 로그인하면 뒤에서 403이 난다."""
        from tools.ntag.personalise import login_payload

        assert login_payload("admin", "secret")["role"] == "admin"


class TestVerifySdmMirror:
    """키 회전 전에 CMAC 구성을 확인하는 유일한 경로.

    회전 전에는 태그가 공장 키로 CMAC을 만들고 서버는 파생 키로 검증하므로,
    서버를 통한 확인은 원리상 통과할 수 없다. 리더로 직접 읽어서 확인해야 한다.
    """

    @staticmethod
    def _tag_filled_ndef(key: bytes, uid_hex: str, read_ctr: int) -> tuple[bytes, dict]:
        """SDM이 켜진 태그가 돌려줄 NDEF를 흉내낸다."""
        from cryptography.hazmat.primitives.ciphers import algorithms
        from cryptography.hazmat.primitives.cmac import CMAC

        from backend.ntag424 import derive_sdm_session_mac_key
        from tools.ntag.ndef import build_sdm_ndef_file

        blank, offsets = build_sdm_ndef_file("https://mediledger.xyz", "pump-001")
        ctx = CMAC(algorithms.AES(derive_sdm_session_mac_key(key, bytes.fromhex(uid_hex), read_ctr)))
        ctx.update(b"")
        cmac_hex = ctx.finalize()[1::2].hex().upper()

        filled = bytearray(blank)
        filled[offsets["uid"] : offsets["uid"] + 14] = uid_hex.encode()
        filled[offsets["ctr"] : offsets["ctr"] + 6] = f"{read_ctr:06X}".encode()
        filled[offsets["cmac"] : offsets["cmac"] + 16] = cmac_hex.encode()
        return bytes(filled), offsets

    def test_accepts_a_mirror_the_tag_actually_produced(self):
        from tools.ntag.personalise import verify_sdm_mirror

        key = bytes(16)
        ndef, offsets = self._tag_filled_ndef(key, "04B07F1A8F1E90", 1)

        ok, uid, ctr = verify_sdm_mirror(ndef, offsets, key)

        assert ok is True
        assert uid == "04B07F1A8F1E90"
        assert ctr == 1

    def test_rejects_a_mirror_signed_with_a_different_key(self):
        """도구와 서버의 키 파생이 어긋나면 여기서 잡혀야 한다 — 회전 뒤에는 늦다."""
        from tools.ntag.personalise import verify_sdm_mirror

        ndef, offsets = self._tag_filled_ndef(bytes(16), "04B07F1A8F1E90", 1)

        ok, _, _ = verify_sdm_mirror(ndef, offsets, bytes(range(16)))

        assert ok is False

    def test_rejects_an_unfilled_mirror(self):
        """SDM이 실제로 동작하지 않으면 플레이스홀더(0)가 그대로 남는다."""
        from tools.ntag.ndef import build_sdm_ndef_file
        from tools.ntag.personalise import verify_sdm_mirror

        blank, offsets = build_sdm_ndef_file("https://mediledger.xyz", "pump-001")

        ok, _, _ = verify_sdm_mirror(blank, offsets, bytes(16))

        assert ok is False


class TestNdefUrlBeforeRotation:
    def test_rejects_same_length_wrong_host_or_token(self):
        from tools.ntag.ndef import build_sdm_ndef_file
        from tools.ntag.personalise import matches_expected_ndef_url

        expected, offsets = build_sdm_ndef_file("https://mediledger.xyz", "pump-001")
        wrong_host, _ = build_sdm_ndef_file("https://mediledger.abc", "pump-001")
        wrong_token, _ = build_sdm_ndef_file("https://mediledger.xyz", "pump-002")

        assert matches_expected_ndef_url(expected, expected, offsets)
        assert not matches_expected_ndef_url(wrong_host, expected, offsets)
        assert not matches_expected_ndef_url(wrong_token, expected, offsets)
