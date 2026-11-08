"""실물 리더의 iBeacon → tag_id 변환 단위 테스트.

리더 모듈은 bleak(BLE 스택)을 import하는데 개발/CI 환경에는 설치돼 있지 않다.
파싱 자체는 순수 함수라, bleak만 스텁으로 끼워 넣고 모듈을 불러온다.
"""

import asyncio
import hashlib
import hmac
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

READER_PATH = Path(__file__).resolve().parents[3] / "rtls" / "rtls_reader" / "send_to_server.py"


def _load_reader_module():
    stub = types.ModuleType("bleak")
    stub.BleakScanner = object
    sys.modules.setdefault("bleak", stub)
    spec = importlib.util.spec_from_file_location("rtls_send_to_server", READER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reader = _load_reader_module()


class FakeAdvertisement:
    """bleak의 AdvertisementData 중 파서가 실제로 읽는 필드만 흉내낸다."""

    def __init__(self, manufacturer_data, service_data=None, rssi=-50):
        self.manufacturer_data = manufacturer_data
        self.service_data = service_data or {}
        self.rssi = rssi


def build_ibeacon_payload(uuid_hex: str, major: int, minor: int) -> bytes:
    return bytes([0x02, 0x15]) + bytes.fromhex(uuid_hex) + major.to_bytes(2, "big") + minor.to_bytes(2, "big") + b"\xc5"


REAL_UUID_HEX = "fda50693a4e24fb1afcfc6eb07647825"
REAL_UUID = "fda50693-a4e2-4fb1-afcf-c6eb07647825"


class TestParseIBeaconTagId:
    def test_pads_the_minor_to_three_digits(self):
        adv = FakeAdvertisement({0x004C: build_ibeacon_payload(REAL_UUID_HEX, 1, 1)})

        assert reader.parse_ibeacon_tag_id(adv) == f"{REAL_UUID}:1:001"

    @pytest.mark.parametrize(
        ("minor", "expected"),
        [(2, "002"), (50, "050"), (999, "999")],
    )
    def test_keeps_three_digit_width_across_the_range(self, minor, expected):
        adv = FakeAdvertisement({0x004C: build_ibeacon_payload(REAL_UUID_HEX, 1, minor)})

        assert reader.parse_ibeacon_tag_id(adv) == f"{REAL_UUID}:1:{expected}"

    def test_leaves_the_major_untouched(self):
        adv = FakeAdvertisement({0x004C: build_ibeacon_payload(REAL_UUID_HEX, 1, 7)})

        assert reader.parse_ibeacon_tag_id(adv).split(":")[1] == "1"

    def test_ignores_advertisements_without_apple_manufacturer_data(self):
        assert reader.parse_ibeacon_tag_id(FakeAdvertisement({})) is None

    def test_ignores_apple_payloads_that_are_not_ibeacon(self):
        adv = FakeAdvertisement({0x004C: bytes([0x10, 0x05]) + b"\x00" * 20})

        assert reader.parse_ibeacon_tag_id(adv) is None


def test_sender_removes_expired_beacon_buffer(monkeypatch):
    reader.tag_samples.clear()
    reader.tag_samples["expired-tag"] = [(1, -70)]
    monkeypatch.setattr(reader.time, "time", lambda: 100)

    async def stop_after_one_pass(_delay):
        raise asyncio.CancelledError

    monkeypatch.setattr(reader.asyncio, "sleep", stop_after_one_pass)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(reader.sender_loop())

    assert "expired-tag" not in reader.tag_samples


def test_sender_signs_exact_body_and_checks_http_status(monkeypatch):
    reader.tag_samples.clear()
    reader.tag_samples["known-tag"] = [(100, -50)]
    monkeypatch.setattr(reader.time, "time", lambda: 100)
    monkeypatch.setattr(reader, "READER_ID", "M501")
    monkeypatch.setattr(reader, "READER_KEY", "test-reader-key-32-bytes-000001", raising=False)
    captured = []

    def post(_url, **kwargs):
        captured.append(kwargs)
        return types.SimpleNamespace(raise_for_status=lambda: None)

    async def stop_after_one_pass(_delay):
        raise asyncio.CancelledError

    monkeypatch.setattr(reader.requests, "post", post)
    monkeypatch.setattr(reader.asyncio, "sleep", stop_after_one_pass)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(reader.sender_loop())

    sent = captured[0]
    headers = sent["headers"]
    body = sent["data"]
    message = (
        f"v1\nM501\n{headers['X-RTLS-Timestamp']}\n{headers['X-RTLS-Nonce']}\n{hashlib.sha256(body).hexdigest()}"
    ).encode()
    assert headers["X-RTLS-Reader-ID"] == "M501"
    assert hmac.compare_digest(
        headers["X-RTLS-Signature"], hmac.new(reader.READER_KEY.encode(), message, hashlib.sha256).hexdigest()
    )


def test_sender_uses_server_date_after_reader_clock_is_wrong(monkeypatch):
    reader.tag_samples.clear()
    reader.tag_samples["known-tag"] = [(100, -50)]
    monkeypatch.setattr(reader.time, "time", lambda: 100)
    monkeypatch.setattr(reader, "READER_ID", "M501")
    monkeypatch.setattr(reader, "READER_KEY", "test-reader-key-32-bytes-000001", raising=False)
    sent = []

    def post(_url, **kwargs):
        sent.append(kwargs)

        def raise_for_status():
            if len(sent) == 1:
                raise reader.requests.HTTPError("clock skew")

        return types.SimpleNamespace(
            headers={"Date": "Thu, 01 Jan 1970 00:16:40 GMT"},
            raise_for_status=raise_for_status,
        )

    async def stop_after_two_passes(_delay):
        if len(sent) == 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(reader.requests, "post", post)
    monkeypatch.setattr(reader.asyncio, "sleep", stop_after_two_passes)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(reader.sender_loop())

    assert len(sent) == 2
    assert sent[0]["headers"]["X-RTLS-Timestamp"] == "100"
    assert sent[1]["headers"]["X-RTLS-Timestamp"] == "1000"
    assert json.loads(sent[1]["data"])["ts"] == 1000
    assert json.loads(sent[1]["data"])["observations"][0]["last_seen"] == 1000


def test_window_length_comes_from_env(monkeypatch):
    monkeypatch.setenv("RTLS_WINDOW_SEC", "2")
    assert _load_reader_module().WINDOW_SEC == 2.0


def test_window_length_defaults_to_five_seconds(monkeypatch):
    monkeypatch.delenv("RTLS_WINDOW_SEC", raising=False)
    monkeypatch.setattr("dotenv.load_dotenv", lambda *_args, **_kwargs: False)
    assert _load_reader_module().WINDOW_SEC == 5.0


FEASY_UUID = "0000fff0-0000-1000-8000-00805f9b34fb"


def feasy_frame(battery: int, length: int = 11) -> bytes:
    """Feasycom 일반 광고 프레임: 모델 1 + 버전 1 + 기능 2 + MAC 6 + 잔량 1 (2026-11-09 실측값 기반)."""
    return (bytes.fromhex("2e022892dc0d3080c333") + bytes([battery]))[-length:]


class TestFeasyBatteryParsing:
    def test_reads_battery_percent_from_the_feasycom_frame(self):
        assert reader.parse_feasy_battery(FakeAdvertisement({}, {FEASY_UUID: feasy_frame(0x64)})) == 100

    def test_ignores_the_external_power_marker(self):
        assert reader.parse_feasy_battery(FakeAdvertisement({}, {FEASY_UUID: feasy_frame(0x65)})) is None

    def test_ignores_a_frame_of_another_length(self):
        assert reader.parse_feasy_battery(FakeAdvertisement({}, {FEASY_UUID: feasy_frame(50, length=10)})) is None

    def test_ignores_an_advertisement_without_the_frame(self):
        assert reader.parse_feasy_battery(FakeAdvertisement({})) is None


def _send_one_pass(monkeypatch) -> dict:
    monkeypatch.setattr(reader, "READER_ID", "M501")
    monkeypatch.setattr(reader, "READER_KEY", "test-reader-key-32-bytes-000001", raising=False)
    captured = []

    def post(_url, **kwargs):
        captured.append(kwargs)
        return types.SimpleNamespace(raise_for_status=lambda: None)

    async def stop_after_one_pass(_delay):
        raise asyncio.CancelledError

    monkeypatch.setattr(reader.requests, "post", post)
    monkeypatch.setattr(reader.asyncio, "sleep", stop_after_one_pass)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(reader.sender_loop())
    return json.loads(captured[0]["data"])


def test_sender_reports_the_battery_heard_from_the_same_beacon(monkeypatch):
    reader.tag_samples.clear()
    reader.tag_battery.clear()
    monkeypatch.setattr(reader.time, "time", lambda: 100)
    beacon = {0x004C: build_ibeacon_payload(REAL_UUID_HEX, 1, 2)}

    reader.on_scan(None, FakeAdvertisement(beacon, {FEASY_UUID: feasy_frame(87)}))

    observation = _send_one_pass(monkeypatch)["observations"][0]
    assert observation["tag_id"].endswith(":1:002")
    assert observation["battery_pct"] == 87


def test_sender_leaves_battery_out_when_none_was_heard(monkeypatch):
    reader.tag_samples.clear()
    reader.tag_battery.clear()
    monkeypatch.setattr(reader.time, "time", lambda: 100)

    reader.on_scan(None, FakeAdvertisement({0x004C: build_ibeacon_payload(REAL_UUID_HEX, 1, 2)}))

    assert "battery_pct" not in _send_one_pass(monkeypatch)["observations"][0]
