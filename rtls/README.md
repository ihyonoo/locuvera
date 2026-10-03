# rtls

Locuvera의 BLE 기반 실시간 위치 추적(RTLS) 엣지 스크립트.

## 설치

```bash
pip install -r rtls/requirements.txt
```

## 실행

```bash
python rtls_tag/ibeacon_broadcast.py   # 태그: iBeacon UUID 브로드캐스트
python rtls_reader/send_to_server.py   # 리더: RSSI 스캔 후 /ingest로 POST
```

BLE 하드웨어가 필요하다(`bleak` 라이브러리 사용).

## 환경 변수 (`rtls/.env`)

- `RTLS_SERVER_URL` — 백엔드 API 주소
- `RTLS_READER_ID` — 리더별 고유 ID(기기마다 다름)
- `RTLS_READER_KEY` — 해당 리더의 요청 서명 키. 백엔드 루트 `.env`의 `RTLS_REAL_READER_KEYS`에서 같은 ID에 등록한 키와 일치해야 한다

`.env.example`을 복사해 기기별로 값을 채운다. 리더마다 서로 다른 키를 사용한다. 리더 시각이 틀려도 서버의 HTTP `Date` 응답으로 다음 요청의 서명 시각을 보정하지만, 운영체제 시각 동기화도 유지한다.

## 관련 문서

- [CLAUDE.md](CLAUDE.md) — 파이프라인 개요
- [backend/](../backend/CLAUDE.md) — 위치 판정 로직(`/ingest` 수신 측)
