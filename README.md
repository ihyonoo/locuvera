# Locuvera

IoT 기반 실내 의료 장비 실시간 위치 추적, 블록체인 기반 사용 이력 무결성 검증 시스템

[![Live](https://img.shields.io/badge/Live-mediledger.xyz-38C172?style=for-the-badge&logo=cloudflare&logoColor=white)](https://mediledger.xyz)

- 의료 장비에 BLE iBeacon 태그 부착, BLE 리더가 신호 세기(RSSI) 보고, 백엔드가 장비의 현재 위치 산출
- 의료진은 웹에서 장비 위치를 실시간 확인
- 의료진이 스마트폰으로 장비의 NFC 태그를 태깅하면 대여·반납 처리 (칩이 매번 새 인증값을 계산해 재사용을 막는다)
- 사용 이력은 프라이빗 Hyperledger Besu 블록체인에 앵커링되어 이후 위·변조 여부 검증 가능
- 사용 이력 구성: 사용자, 장비, 사용 시각, 반납 시각, 사용 위치

---

## 목차

- [주요 기능](#주요-기능)
- [기술 스택](#기술-스택)
- [시스템 구성](#시스템-구성)
- [실행](#실행)
- [동작 원리](#동작-원리)
- [NFC 태깅과 사용 이력](#nfc-태깅과-사용-이력)
- [블록체인 무결성 검증](#블록체인-무결성-검증)
- [가상 병원 시뮬레이션](#가상-병원-시뮬레이션)
- [블록체인 분산 구성](#블록체인-분산-구성)
- [코드 품질](#코드-품질)

---

## 주요 기능


| 기능          | 내용                                              |
| ----------- | ----------------------------------------------- |
| 실시간 위치 추적   | 리더가 보고한 RSSI로 장비 위치 산출, 의료진 화면에 1초 폴링 반영        |
| 사용 이력 관리    | NTAG 424 DNA 태깅으로 대여(checkout)·반납(return) 기록. 재사용·위조 불가 |
| 블록체인 앵커링    | 반납 완료 기록을 Besu 체인에 기록                           |
| 무결성 검증      | 관리자 화면에서 DB 기록과 온체인 값 대조 (온체인 원문 일치, 머클루트 일치)   |
| 역할 기반 접근    | 관리자(admin) / 의료진(staff) 권한 분리                   |
| 가상 병원 시뮬레이션 | 실물 하드웨어 없이 구역 42 · 장비 50 · 의료진 120 규모 트래픽 상시 생성 |


---

## 기술 스택

**백엔드**

![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat&logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=flat&logo=redis&logoColor=white)

psycopg 3로 직접 쿼리(ORM 미사용), Redis는 위치 캐시(best-effort)

**프론트엔드**

![React](https://img.shields.io/badge/React_18-61DAFB?style=flat&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/TailwindCSS_v4-06B6D4?style=flat&logo=tailwindcss&logoColor=white)
![React Router](https://img.shields.io/badge/React_Router_v7-CA4245?style=flat&logo=reactrouter&logoColor=white)

**블록체인**

![Hyperledger Besu](https://img.shields.io/badge/Hyperledger_Besu-2F3134?style=flat&logo=hyperledger&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-363636?style=flat&logo=solidity&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)

QBFT 합의, `UsageRecordRegistry.sol`, 백엔드가 subprocess로 호출하는 Node.js(ethers) 스크립트

**엣지(RTLS)**

![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white)
![Bluetooth](https://img.shields.io/badge/BLE-0082FC?style=flat&logo=bluetooth&logoColor=white)

bleak 라이브러리로 BLE 스캔·브로드캐스트

---

## 시스템 구성

Compose 파일은 3개, 이 중 블록체인 스택만 공유한다.

```
              blockchain/besu/docker-compose.yml
              (validator1~4 · rpc-node)
                     ▲                ▲
             include │                │ include
                     │                │
      docker-compose.dev.yml    docker-compose.yml
      (로컬 개발)                (홈서버 배포)
```

```
[로컬 개발] docker-compose.dev.yml
  컨테이너 : postgres · redis · besu(검증자 4 + RPC 노드 1)
  호스트   : uvicorn backend :8000 · vite dev :5173
  접속     : localhost 5432 / 6379 / 8549

[홈서버 배포] docker-compose.yml
  컨테이너 : postgres · redis · backend · web(nginx) · simulator
             · besu(검증자 4 + RPC 노드 1) · cloudflared
  외부 노출: cloudflared 터널로 mediledger.xyz 연결 (포트 개방 없음)
```

- 로컬은 인프라만 컨테이너화하고 앱은 호스트에서 실행 (코드 변경 시 hot-reload)
- 배포는 앱까지 전부 컨테이너화
- `simulator`는 포트를 열지 않고 컨테이너 DNS로 `backend`에만 요청하는 클라이언트
- validator는 호스트 포트를 열지 않고 컨테이너 네트워크 내부에서만 통신
- redis는 dev/배포에서 포트 바인딩·네트워크 소속이 달라 공유하지 않고 각 파일에 정의
- `blockchain/besu/.env`(부트노드 enode 등)는 `env_file:`로 include 시점에 주입
- `blockchain/besu/`에서 `docker compose up -d`로 블록체인만 단독 기동 가능

---

## 실행

로컬은 하이브리드 구성이다. DB·Redis·Besu는 컨테이너, 앱은 호스트에서 실행한다.

`bash scripts/dev-up.sh` 한 줄로 인프라 → 스키마 적용·재시드 → 백엔드 → 프론트엔드 → 시뮬레이터까지 기동된다(멱등). 아래는 개별 실행 절차다.

### 0) 최초 1회 준비

```bash
# .env 준비 (.env.example 참고)
# Besu 네트워크 산출물 생성 (genesis, 검증자 키, blockchain/besu/.env)
bash blockchain/besu/scripts/generate-network.sh
```

### 1) 인프라 (DB · Redis · Besu)

```bash
docker-compose -f docker-compose.dev.yml up -d   # postgres · redis · besu(4+1)
psql "$DATABASE_URL" -f database/schema.sql      # 스키마 적용 (멱등)

# 컨트랙트 배포 (최초 1회)
cd blockchain/besu && npm install && node scripts/deploy-usage-registry.mjs && cd -
```

- DB는 named volume `mediledger_pgdata`에 영속, 접속 `postgresql://mediledger:mediledger@localhost:5432/mediledger_db`
- 정지는 `docker-compose -f docker-compose.dev.yml down` (`-v`는 볼륨까지 삭제하므로 금지)
- RPC 엔드포인트 `http://127.0.0.1:8549` (chain ID 1337, QBFT)
- 블록체인 미기동 시 백엔드는 앵커링·검증만 건너뛰고 나머지 기능은 정상 동작

### 2) 백엔드 (저장소 루트)

```bash
pip install -r backend/requirements.txt
uvicorn backend.server:app --host 0.0.0.0 --port 8000
```

### 3) 프론트엔드 (`frontend/`)

```bash
npm install
npm run dev            # Vite dev 서버 :5173
npm run build          # 변경 후 검증
```

### 4) RTLS 엣지 (`rtls/`, BLE 하드웨어 필요)

```bash
pip install -r requirements.txt
python rtls_tag/ibeacon_broadcast.py   # Tag: iBeacon UUID 브로드캐스트
python rtls_reader/send_to_server.py   # Reader: RSSI 스캔 후 /ingest 로 POST
```

### 5) 가상 병원 시뮬레이터 (저장소 루트, 하드웨어 불필요)

```bash
python -m simulation.apply_seed        # 시드 적용 (최초 1회, topology 변경 후)
python -m simulation.simulator         # 상시 가동
```

---

## 동작 원리

<img src="assets/readme/scenario.png" alt="전체 사용 시나리오" width="50%">

### 위치 산출

1. 리더가 태그별 RSSI를 2초 창으로 모아 `POST /ingest`로 배치 전송
2. 백엔드가 가장 센 신호의 리더로 태그 위치 판정 (히스테리시스·dwell·staleness 임계값으로 흔들림 억제)
3. PostgreSQL(원본) 저장 후 Redis(캐시) 갱신 (write-through)
4. 의료진 화면이 `GET /rtls/live`를 1초 폴링해 Redis+DB 병합 결과 렌더 (Redis 장애 시 DB 폴백)

### 사용 이력과 앵커링

1. 태깅으로 검증된 탭 세션을 받아 `POST /usage/checkout` · `POST /usage/return`으로 `usage_history` 행을 열고 닫음
2. 반납 시 완료 기록을 온체인에 앵커링. 백엔드는 라이브러리 대신 subprocess로 `blockchain/besu/scripts/`의 Node 스크립트 호출(`record-usage-record.mjs`)
3. 이름·부서 등 표시용 필드는 앵커링에서 제외, 최소 사실 기록만 온체인 저장

<img src="assets/readme/sequence.png" alt="시퀀스 다이어그램" width="50%">

---

## NFC 태깅과 사용 이력

BLE 태그가 위치 추적을 담당한다면, NFC는 같은 장비(`tags` 테이블의 같은 행)에 붙는 대여·반납 트리거다.

물리 태그는 **NTAG 424 DNA**를 쓰고 SDM(Secure Dynamic Messaging)을 켠다. 칩이 태깅할 때마다 URL을
직접 다시 계산해, 자신의 UID와 단조 증가 카운터, 그리고 둘을 덮는 CMAC을 실어 보낸다.

```
https://mediledger.xyz/nfc/pump-001?uid=04AABBCCDDEE80&ctr=00019A&cmac=A1B2C3D4E5F60718
```

경로의 토큰은 장비를 가리키고, 쿼리스트링이 그 태깅이 진짜였음을 증명한다.

이전 방식(NTAG215에 고정 URL 기록)은 폐기했다. 고정 URL은 한 번 노출되면 어디서든 재사용할 수 있어,
"그 사람이 장비 앞에 있었다"를 전혀 보장하지 못했다. 온체인 앵커링이 기록의 사후 변조를 막아도
입력 단계가 위조 가능하면 무결성 주장 자체가 성립하지 않는다.

### 서버가 확인하는 것

1. **CMAC** — 마스터키와 UID로 파생한 태그별 키로 재계산해 대조. 위조 태그를 거른다
2. **카운터** — 이전에 받아들인 값보다 커야 한다. 캡처한 URL의 재사용을 거른다
3. **UID ↔ 토큰 교차검증** — 유효한 쿼리스트링을 다른 장비 URL에 붙이는 시도를 거른다

셋 다 통과하면 카운터를 소비하면서 **1회용 탭 세션**(유효 3분)을 발급한다. 태깅 한 번이 만드는 유효한
CMAC은 하나뿐인데 조회와 실행은 요청이 두 번이라, 조회 단계에서 발급한 세션이 실행 권한을 나르는 구조다.
마스터키는 `.env`에만 두고 DB에는 저장하지 않는다.

### 의료진: 태깅으로 대여·반납

1. 스마트폰으로 태그를 태깅하면 칩이 계산한 URL이 열리며 `/nfc/:token` 진입
2. 서버가 검증 후 장비 상태·위치와 탭 세션을 반환 (`GET /nfc/{token}`)
3. "사용 시작" / "사용 종료" 버튼이 그 세션과 함께 `POST /usage/checkout` · `POST /usage/return` 호출
4. 반납 시 완료 기록 자동 앵커링

쿼리스트링 없이 `/nfc/pump-001`로 직접 들어오면 404다. 즐겨찾기나 URL 복사로는 화면조차 열리지 않는다.

### 관리자: 태그 개인화와 매핑

- 태그 개인화는 USB PC/SC 리더를 꽂은 로컬 도구 `tools/ntag/`가 담당한다 (휴대폰 앱으로는 불가능)
- 칩 UID는 도구가 `POST /admin/ntag-bindings`로 등록한다. UID는 다른 장비로 재바인딩하지 않는다
- `/admin/nfc-mapping`은 현황 조회와 해제용이다

### 시뮬레이션 장비

시뮬레이터에는 물리 칩이 없으므로 근접성 증명이라는 개념이 성립하지 않는다. 그래서 탭 세션 요구는
`tags.is_real_hardware`가 TRUE인 행에만 적용된다. 이 면제는 오직 그 컬럼으로만 결정되며,
역할·계정·헤더로는 실물 태그가 면제를 얻을 수 없다.

### 이벤트 로그

- 장비를 특정할 수 있는 거부(`cmac_mismatch`, `counter_replay`, `uid_token_mismatch`)는 `usage_nfc_events`에 감사 기록으로 남는다
- 미등록 UID처럼 장비를 특정할 수 없는 거부는 기록 없이 404로 끝난다
- `usage_history.checkout_method` / `return_method`로 NFC 처리와 수동(manual) 처리 구분

---

## 블록체인 무결성 검증

관리자가 이력 화면(`GET /usage/history?include_blockchain=true`)에 진입하면:

1. `usage_history`를 DB에서 조회
2. 각 기록을 체인에서 다시 읽어 현재 DB 값과 대조 (`verify-usage-records.mjs`)
  - 온체인 원문 일치 (`tx_input_matches_db`)
  - 머클루트 일치 (`transactions_root_matches`)
3. DB가 수정된 경우 재계산 해시가 온체인 값과 불일치로 드러남

---

## 가상 병원 시뮬레이션

### 도입 배경

- 확보한 실물 하드웨어는 라즈베리파이 리더 2대(M501 중앙수술센터, M502 통원수술센터)와 비컨 태그 소수뿐
- 규모가 있어야 검증되는 항목이 다수: 위치 판정 임계값(히스테리시스·dwell)의 흔들림 억제, 다구역 지도 렌더, 이력 조회·페이징, 앵커링 처리량
- 수동으로 넣은 더미 데이터에는 시간대·요일 분포, 이동 경로, 동시 대여 수 변동이 없어 화면·통계 검증에 부적합
- 구역 42개에 리더를, 장비 50대에 비컨을 설치하는 것은 비용·설치 모두 프로젝트 범위 밖
- 대안으로 실물 리더와 동일한 HTTP 규격으로 백엔드에 접속하는 가상 병원 1개를 상시 가동 (순천향대학교 천안병원 본관 1~5층 구성 기반)

### 설계 원칙


| 원칙             | 내용                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 서버는 시뮬레이터를 모른다 | 시뮬레이터는 `/ingest`, `/auth/login`, `/usage/checkout`, `/usage/return`만 호출하는 HTTP 클라이언트. 백엔드에 시뮬레이션 전용 코드 경로 없음. 서버가 요청 출처를 구분하지 못하므로 시뮬레이터로 검증한 동작이 곧 실물 경로의 검증 |
| 구분은 데이터로만      | 실물·가상 구분은 시드의 `is_real_hardware` 플래그. 태그 ID의 major 자리도 `1`=실물, `2`=시뮬레이션으로 분리                                                                                 |
| 정본과 산출물 분리     | `simulation/topology/`(구역 폴리곤·인접 그래프·장비 카탈로그·의료진 로스터)가 정본. 시드 SQL과 프론트엔드 층별 좌표 TS는 `generate_seed.py`가 생성하는 산출물                                               |
| 실물 구역 불가침      | 실물 리더 담당 구역 M501·M502는 시뮬레이션 대상에서 제외. 실물 하드웨어를 켜도 같은 지도 위에 충돌 없이 공존                                                                                           |
| 런타임은 DB 미접근    | DB 접근은 시딩(`apply_seed`) 전용. 기동 후에는 실물 리더와 동일하게 HTTP로만 통신                                                                                                      |


### 시뮬레이션 대상


| 대상     | 규모                                      |
| ------ | --------------------------------------- |
| 구역(리더) | 42개 (본관 1~5층, 실물 담당 구역 제외)              |
| 장비(태그) | 50대 / 20종 (수액펌프·제세동기·초음파진단기 등 이동형 의료기기) |
| 의료진    | 120명 (직종·담당 층별 구분, 3교대 또는 평일 상근·온콜)     |


### 구조

```
simulation/topology/  (정본: 구역 폴리곤 · 인접 그래프 · 장비 · 의료진)
        │
        ├─ generate_seed.py ──→ 시드 SQL + 프론트 층별 좌표 TS (산출물)
        │                              │
        │                       apply_seed.py ──→ PostgreSQL
        │
        └─ simulator.py (asyncio 프로세스 1개, 루프 4개)
                 │
                 ▼
            HTTP  ──→  backend  ──→  위치 판정 · 사용 이력 · 온체인 앵커링
        (/ingest · /auth/login · /usage/checkout · /usage/return)
```


| 루프    | 주기      | 역할                                                                                                           |
| ----- | ------- | ------------------------------------------------------------------------------------------------------------ |
| 물리    | 200ms   | 실물 태그의 iBeacon 브로드캐스트 주기와 동일. 장비 위치 갱신, 리더별 RSSI 샘플 생성                                                       |
| 리더    | 1초      | 리더 42개가 각자 2초 윈도우 median RSSI를 `POST /ingest`로 전송. 실물 리더 스크립트와 동일 규격(`WINDOW_SEC=2.0`, `SEND_EVERY_SEC=1.0`) |
| 행동    | 10초     | 수요 곡선 기반 확률 추첨으로 대여 판정, 대여 상태 머신 전이                                                                          |
| 반납 워커 | 큐 기반 직렬 | 반납이 온체인 앵커링을 트리거하므로 nonce 충돌 방지를 위해 항상 1건씩 처리                                                                |


- 루프 하나가 죽으면 예외를 그대로 올려 프로세스 전체 종료 (일부 루프만 정지한 채 정상으로 보이는 상태 방지)

### 모델

- **전파**: `RSSI(d) = -59 - 20·log10(d) - 6·(벽 홉 수) + 태그 개체차 + 느린 노이즈(OU) + 빠른 노이즈`. 수신 감도 −95dBm, 최대 유효 거리 40m. 벽 감쇠는 태그 구역과 리더 구역 간 인접 그래프 최단 홉 수로 근사
- **이동**: 인접 그래프(42노드 51엣지, 구역 폴리곤 경계 간격에서 도출)의 최단경로를 따라 평균 1.1m/s로 이동, 층 이동 없음. 벽 통과·순간이동 궤적 방지
- **수요 곡선**: 장비를 급성기(24시간 가동, 주말 영향 적음)와 외래(진료 시간 집중, 야간·일요일 거의 정지)로 분류해 시간대·요일 배율 적용. 동시 대여 수가 목표 밴드(주간 8~~14대, 야간 2~~4대)를 벗어나면 피드백 계수가 체크아웃 확률 조정. 야간에 드물게 응급 버스트(3배 배율) 발생
- **대여 상태 머신**: `AVAILABLE → TRANSIT → IN_USE → (TRANSIT → IN_USE)* → RETURNING → 반납`. 대여 1건이 사용지 1~4곳 경유, 시각·구역·직종 조건을 만족하는 근무 중 직원만 대여·반납 가능
- **예외 이벤트**: 현실의 어긋남을 의도적으로 포함. 예상보다 긴 사용(5%), 엉뚱한 위치 반납(3%), 스캔 실수 후 즉시 반납(2%), 대여자 퇴근 후 동료의 대리 반납(퇴근 시 85%)

### 산출 규모

- 평일 주간 동시 대여 평균 8~9대, 야간 3대 안팎
- 하루 대여 약 142건 (24시간 오프라인 측정 기준), 반납 건은 전량 앵커링

### 운용

- 실행 절차는 [실행](#실행) 5) 참고. 로컬은 `simulation/.env`, 홈서버 배포는 루트 `.env`에서 설정 주입
- `SIM_STAFF_PASSWORD` 필수, 없으면 즉시 종료
- `SIM_RANDOM_SEED`를 지정하면 궤적 재현 가능, 비우면 기동마다 다른 궤적
- 홈서버 배포에서는 `simulator` 컨테이너로 상시 가동
- 상세: [`simulation/README.md`](simulation/README.md)

---

## 블록체인 분산 구성

### 현재 개발 구성의 한계

검증자 4개와 RPC 노드가 모두 개발용 노트북 한 대의 컨테이너로 실행된다.

- 노트북을 끄면 체인 전체가 정지 (데이터는 볼륨에 보존되어 재시작 시 재개, 초기화는 아님)
- 각 컨테이너의 데이터 폴더를 전부 지우면 이력 소멸 (일부 노드만 삭제하면 나머지에서 재동기화)
- 한 주체가 한 장소에서 모든 노드를 통제하는 구성은 물리적으로만 다중 노드일 뿐, 단일 장애점이며 조작 가능

### 컨소시엄 구성

블록체인의 신뢰 비의존성(trustless)은 검증자를 서로 독립적인 주체가 나누어 운영할 때 성립한다.


| 참여 주체   | 역할               |
| ------- | ---------------- |
| 참여 병원   | 각 병원이 검증자 1개씩 운영 |
| 규제·공공기관 | 보건복지부·식약처 등 감독   |
| 감사·보험사  | 제3자 검증           |
| 장비 제조사  | 이력 추적 이해관계자      |
| 인증기관    | 무결성 보증           |


- 한 병원이 사용 기록을 조작해도 나머지 노드가 거부

### 내결함성 (QBFT)

검증자 `3f+1`개로 장애·악의 노드 `f`개를 허용한다.


| 검증자 수 | 허용 장애 노드 |
| ----- | -------- |
| 4     | 1        |
| 7     | 2        |
| 10    | 3        |


---

## 코드 품질

- **JS/TS**: ESLint(`eslint.config.mjs`) + Prettier(`.prettierrc`), `npm run lint`
- **Python**: Ruff(`pyproject.toml`)로 린트·포맷. 개발 의존성은 저장소 루트에서 `pip install -r requirements-dev.txt` 한 번이면 ruff·pytest와 테스트용 런타임까지 모두 설치된다
- **커밋 훅**: Husky + lint-staged가 스테이징된 파일만 검사·수정 (`.husky/pre-commit`)
- **PR 검사**: `main` 대상 PR에서 GitHub Super-Linter가 변경 파일 재검증 (`.github/workflows/super-linter.yml`)
- **테스트**: 저장소 루트에서 `pytest`
