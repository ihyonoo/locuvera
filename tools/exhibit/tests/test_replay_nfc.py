"""NFC 재전송·위조 시연: 이미 쓴 태깅 URL에서 공격 요청을 만든다."""

import pytest

from tools.exhibit.replay_nfc import build_attempts, next_counter, parse_tap_url

USED_URL = "https://mediledger.xyz/nfc/pump-001?uid=04B07F1A8F1E90&ctr=00000A&cmac=A1B2C3D4E5F60718"


def test_parses_the_token_and_the_sdm_query():
    tap = parse_tap_url(USED_URL)

    assert tap.token == "pump-001"
    assert tap.uid == "04B07F1A8F1E90"
    assert tap.ctr == "00000A"
    assert tap.cmac == "A1B2C3D4E5F60718"


def test_rejects_a_url_without_the_chip_proof():
    with pytest.raises(SystemExit):
        parse_tap_url("https://mediledger.xyz/nfc/pump-001")


@pytest.mark.parametrize(("ctr", "expected"), [("00000A", "00000B"), ("0000FF", "000100"), ("00019a", "00019B")])
def test_next_counter_keeps_the_width(ctr, expected):
    assert next_counter(ctr) == expected


def test_replays_the_same_url_then_forges_the_next_counter_with_the_old_cmac():
    replay, forged = build_attempts(parse_tap_url(USED_URL))

    assert replay.token == forged.token == "pump-001"
    assert replay.query == {"uid": "04B07F1A8F1E90", "ctr": "00000A", "cmac": "A1B2C3D4E5F60718"}
    assert forged.query == {"uid": "04B07F1A8F1E90", "ctr": "00000B", "cmac": "A1B2C3D4E5F60718"}
