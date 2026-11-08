"""측위 보고 위조 시연: 보낼 요청 구성과 판정. 네트워크 I/O는 없다."""

import hashlib
import hmac
import json

import pytest

from tools.exhibit.forge_ingest import build_forged_reports, pick_target_reader

TAG_ID = "fda50693-a4e2-4fb1-afcf-c6eb07647825:1:002"
NOW = 1_762_700_000
FAKE_KEY = "attacker-guess-key"


def nonce_counter():
    count = 0

    def make():
        nonlocal count
        count += 1
        return f"{count:032x}"

    return make


def build():
    return build_forged_reports("M502", TAG_ID, NOW, make_nonce=nonce_counter(), attacker_key=FAKE_KEY)


def test_builds_three_reports_that_claim_the_tag_moved():
    reports = build()

    assert len(reports) == 3
    for report in reports:
        body = json.loads(report.body)
        assert body["observations"][0]["tag_id"] == TAG_ID
        assert body["reader_id"] == report.headers.get("X-RTLS-Reader-ID", body["reader_id"])


def test_first_report_carries_no_signature():
    unsigned = build()[0]

    assert "X-RTLS-Signature" not in unsigned.headers
    assert json.loads(unsigned.body)["reader_id"] == "M502"


def test_second_report_impersonates_a_registered_reader_with_a_guessed_key():
    forged = build()[1]
    body = forged.body
    message = (
        f"v1\nM502\n{forged.headers['X-RTLS-Timestamp']}\n{forged.headers['X-RTLS-Nonce']}\n"
        f"{hashlib.sha256(body).hexdigest()}"
    ).encode("ascii")

    assert forged.headers["X-RTLS-Reader-ID"] == "M502"
    assert forged.headers["X-RTLS-Signature"] == hmac.new(FAKE_KEY.encode(), message, hashlib.sha256).hexdigest()


def test_third_report_comes_from_an_unregistered_reader():
    unknown = build()[2]

    assert unknown.headers["X-RTLS-Reader-ID"] == "M999"
    assert json.loads(unknown.body)["reader_id"] == "M999"


def test_every_report_uses_a_fresh_nonce():
    nonces = [report.headers.get("X-RTLS-Nonce") for report in build()[1:]]

    assert len(set(nonces)) == len(nonces)


READERS = [
    {"reader_id": "M501", "location": "중앙수술센터", "is_online": True},
    {"reader_id": "M502", "location": "통원수술센터", "is_online": True},
]


def test_targets_the_other_real_reader_so_an_accepted_report_would_move_the_tag():
    assert pick_target_reader(READERS, "M501")["reader_id"] == "M502"
    assert pick_target_reader(READERS, "M502")["reader_id"] == "M501"


def test_falls_back_to_any_real_reader_when_the_tag_has_no_location():
    assert pick_target_reader(READERS, None)["reader_id"] in {"M501", "M502"}


def test_refuses_to_run_without_a_real_reader():
    with pytest.raises(SystemExit):
        pick_target_reader([], "M501")
