# send_to_server.py

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import statistics
import time
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests
from bleak import BleakScanner
from dotenv import load_dotenv

# RTLS 리더는 rtls/.env를 기준으로 장비별 설정을 읽는다.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

SERVER_URL = os.getenv("RTLS_SERVER_URL", "http://127.0.0.1:8000/ingest")  # Server IP
READER_ID = os.getenv("RTLS_READER_ID", "M501")  # Reader의 논리적 ID
READER_KEY = os.getenv("RTLS_READER_KEY", "")

# 윈도우를 사용하는 이유: RSSI의 튐 현상, 노이즈 감소를 위해
WINDOW_SEC = 5.0  # 수집 윈도우(최근 5초 동안의 RSSI를 수집)
SEND_EVERY_SEC = 1.0  # 전송 주기(1초마다 서버로 전송)


# 태그별 RSSI 임시 저장 버퍼
# tag_id -> list of (timestamp, rssi)
tag_samples = {}


# iBeacon UUID(byte) -> tag_id(문자열) 파싱
def bytes_to_uuid(b: bytes) -> str:
    h = b.hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


# iBeacon인지 검증하고 시스템에서 쓰는 tag_id 형식으로 변환
def parse_ibeacon_tag_id(adv) -> str | None:
    md = adv.manufacturer_data  # 제조사의 ID를 가져옴
    if 0x004C not in md:  # 0x004c는 Apple Company ID
        return None

    data = md[0x004C]

    if len(data) < 22 or data[0] != 0x02 or data[1] != 0x15:  # iBeacon prefix: 02 15
        return None

    uuid = bytes_to_uuid(data[2:18]).lower()
    major = int.from_bytes(data[18:20], "big")
    minor = int.from_bytes(data[20:22], "big")

    # minor는 3자리로 고정한다 — 시뮬레이션 태그(major 2)와 같은 표기를 쓰기 위해서다.
    return f"{uuid}:{major}:{minor:03d}"


# 스캔 콜백은 태그 판별과 버퍼 적재만 담당하고, 서버 전송은 별도 루프에서 수행한다.
def on_scan(device, adv):
    tag_id = parse_ibeacon_tag_id(adv)
    if tag_id is None:
        return

    ts = int(time.time())  # 수신 시각
    rssi = int(adv.rssi)  # RSSI 값

    # 해당 태그의 버퍼에 (수신 시각, RSSI 값) 추가
    tag_samples.setdefault(tag_id, []).append((ts, rssi))


# 가공 후 서버로 전송 루프
async def sender_loop():
    server_time_offset = 0
    while True:
        now = int(time.time())  # 현재 시간 계산
        cutoff = now - int(WINDOW_SEC)  # Window만큼 자르기

        observations = []  # 서버로 보낼 태그별 요약값 리스트
        for tag_id, samples in list(tag_samples.items()):  # 현재 버퍼의 모든 태그에 대해 처리
            samples = [(t, r) for (t, r) in samples if t >= cutoff]  # 윈도우 밖 데이터 제거
            # 샘플이 없는 태그는 전송 대상에서 제외
            if not samples:
                tag_samples.pop(tag_id, None)
                continue
            tag_samples[tag_id] = samples

            rssis = [r for (_, r) in samples]  # RSSI 값만 추출
            rssi_med = int(statistics.median(rssis))  # 중앙값 계산
            last_seen = max(t for (t, _) in samples)  # window 내에서 가장 최근 수신 시각

            # 서버로 보낼 데이터 구성
            observations.append(
                {
                    "tag_id": tag_id,  # tag_id
                    "rssi": rssi_med,  # RSSI의 중앙값
                    "count": len(rssis),  # window 내 샘플 개수(신뢰도)
                    "last_seen": last_seen + server_time_offset,  # 마지막 수신 시간
                }
            )

        # HTTP 전송
        if observations:  # 전송할 데이터가 있다면
            if not READER_KEY:
                raise RuntimeError("RTLS_READER_KEY가 설정되지 않았습니다.")
            # 서버로 보낼 전체 페이로드 구성
            payload = {
                "reader_id": READER_ID,  # 리더기 ID
                "ts": now + server_time_offset,  # 전송 시각
                "observations": observations,  # 태그별 요약 리스트
            }

            body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            timestamp = str(int(time.time()) + server_time_offset)
            nonce = secrets.token_hex(16)
            message = f"v1\n{READER_ID}\n{timestamp}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode("ascii")
            signature = hmac.new(READER_KEY.encode("utf-8"), message, hashlib.sha256).hexdigest()
            headers = {
                "Content-Type": "application/json",
                "X-RTLS-Reader-ID": READER_ID,
                "X-RTLS-Timestamp": timestamp,
                "X-RTLS-Nonce": nonce,
                "X-RTLS-Signature": signature,
            }

            try:
                response = await asyncio.to_thread(requests.post, SERVER_URL, data=body, headers=headers, timeout=2)
                server_date = getattr(response, "headers", {}).get("Date")
                if server_date:
                    try:
                        parsed_date = parsedate_to_datetime(server_date)
                        if parsed_date.tzinfo is not None:
                            server_time_offset = round(parsed_date.timestamp() - time.time())
                    except (TypeError, ValueError, OverflowError):
                        pass
                response.raise_for_status()
            except requests.RequestException as exc:
                print("send fail:", exc)

        # 비동기 방식으로 1초 대기 후 다시 실행(전체 프로그램이 멈추는 게 아니라 해당 함수만 sleep)
        await asyncio.sleep(SEND_EVERY_SEC)


# Scan 가동, 서버로 전송
async def main():
    scanner = BleakScanner(on_scan)  # 콜백 등록(스캐너 생성)
    await scanner.start()  # 스캔 시작(백그라운드)
    try:
        await sender_loop()  # 전송 루프 실행
    finally:
        await scanner.stop()  # 종료 시 스캔 정리


if __name__ == "__main__":
    asyncio.run(main())  # 이벤트 루프 시작
