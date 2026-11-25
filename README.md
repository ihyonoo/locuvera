# Locuvera

블록체인과 실내 측위 기술을 활용한 의료 장비 사용 이력 무결성 검증 시스템

[![Live](https://img.shields.io/badge/Live-mediledger.xyz-38C172?style=for-the-badge&logo=cloudflare&logoColor=white)](https://mediledger.xyz)

**의료진** · 도면 위 실시간 장비 위치 조회(웹), NFC 태깅으로 대여·반납(모바일)

<img src="assets/readme/demo-staff.gif" alt="의료진 화면: 층별 도면에서 장비 위치를 조회하고, 휴대폰으로 NFC 태그를 태깅해 대여·반납하는 장면" width="100%">

**관리자** · 사용 이력 조회, 블록체인 대조 무결성 검증 증명서, 장비 가동률 분석

<img src="assets/readme/demo-admin.gif" alt="관리자 화면: 사용 이력 목록과 검증 증명서, 가동률 분석 화면" width="100%">

<sub>도면 이미지 출처: 순천향대학교 천안병원</sub>

---

## 목차

- [왜 필요한가](#왜-필요한가)
- [전체 흐름](#전체-흐름)
- [아키텍처](#아키텍처)
- [핵심 설계](#핵심-설계)
- [평가](#평가)
- [한계와 향후 과제](#한계와-향후-과제)
- [가상 병원 시뮬레이션](#가상-병원-시뮬레이션)
- [실행](#실행)
- [시스템 구성](#시스템-구성)
- [코드 품질](#코드-품질)

---

## 왜 필요한가

- 의료분쟁의 주요 근거인 의무기록은 환자 중심으로 작성되므로, 장비 관련 사고에서 **어떤 장비를 누가·언제·어디서 썼는지** 파악하기 어려움. 장비 단위의 사용 이력이 이를 보완함
- 간호사는 근무 교대당 평균 21~60분을 장비 탐색에 소비함. 실시간 위치 추적(RTLS)은 탐색 시간을 줄이지만 위치만 제공함
- 사용 이력이 증거가 되려면 **입력 단계의 신뢰성**과 **저장 단계의 무결성**이 모두 필요함. 입력이 위조 가능하면 블록체인은 잘못된 데이터의 무결성만 보장함(GIGO)

| 단계     | 위협               | 대응                                                   |
| ------ | ---------------- | ---------------------------------------------------- |
| 위치 보고  | 리더 보고 위조·재전송     | 리더별 비밀키 HMAC, 전송 시각 허용 오차, nonce 중복 거부              |
| NFC 태깅 | 태그 복제, 태깅 URL 재전송 | NTAG 424 DNA 동적 인증: 태깅마다 새 CMAC, 단조 증가 읽기 카운터       |
| 저장     | 데이터베이스 사후 변조     | Hyperledger Besu 프라이빗 블록체인 기록, 조회 시 4계층 대조 검증 |

---

## 전체 흐름

<img src="assets/readme/overview.png" alt="제안 시스템의 전체 구성과 동작 흐름" width="80%">

- 의료진이 웹에서 장비 위치를 조회하고 장비로 이동해 NFC 태깅으로 대여, 사용 후 진료과에서 다시 태깅해 반납
- 이력 항목은 사람이 입력하지 않음: 사용자는 로그인 계정, 시각은 서버 시각, 위치는 BLE 판정 구역에서 채움
- 반납이 끝난 이력은 데이터베이스(원본)와 블록체인(검증 정보)에 함께 저장되고, 관리자가 조회할 때마다 둘을 대조함

---

## 아키텍처

<img src="assets/readme/architecture.png" alt="제안 시스템의 아키텍처" width="80%">

| 영역      | 구성                                                                         |
| ------- | -------------------------------------------------------------------------- |
| 애플리케이션 서버 | Python 3.12 · FastAPI, psycopg 3 직접 쿼리(ORM 미사용)                             |
| 데이터     | PostgreSQL 17(원본) · Redis 7(위치 캐시, best-effort)                            |
| 웹 프론트엔드 | TypeScript · React 18 · Vite 6 · Tailwind CSS v4 · React Router v7 · three.js(3D 도면) |
| 블록체인    | Hyperledger Besu(QBFT, 검증 노드 4 + RPC 노드 1) · Solidity 0.8 · Node.js 20(ethers) |
| 엣지(RTLS) | Raspberry Pi 5 리더(Python · Bleak), Feasycom FSC-BP104D 비콘(0.2초 광고)          |
| NFC 태그  | NXP NTAG 424 DNA(SDM/SUN), 개인화 도구 `tools/ntag/`(USB PC/SC 리더)              |

백엔드는 블록체인 기록·검증을 `blockchain/besu/scripts/`의 Node.js 스크립트를 셸 없이 서브프로세스로 실행해 처리한다. 블록체인이 꺼져 있으면 기록·검증만 건너뛰고 나머지 기능은 정상 동작한다.

---

## 핵심 설계

### 1. 실내 측위: 구역 단위 위치 판정

<img src="assets/readme/location-decision.png" alt="신호 수집과 위치 판정 과정" width="65%">

- 리더는 광고 패킷을 하나씩 보내지 않고, 태그별 RSSI를 수집 윈도우로 모아 중앙값을 1초마다 `POST /ingest`로 전송
- 서버는 등록·활성 리더의 보고만 수용. 리더 ID·전송 시각·nonce·본문 해시를 리더별 키로 HMAC 검증하고, 시각 허용 오차 밖의 보고와 이미 쓴 nonce를 거부함. 키 하나가 유출돼도 위조 범위는 그 리더로 한정
- 가장 센 신호의 리더 구역을 장비 위치로 판정하되, 경계에서의 흔들림을 세 조건으로 억제

| 조건     | 의미                              | 시뮬레이션 | 실물 리더 |
| ------ | ------------------------------- | ----- | ----- |
| 히스테리시스 | 후보 리더가 현재 리더보다 이만큼 강해야 전환 후보    | 10 dB | 6 dB  |
| 체류 시간  | 같은 후보가 이 시간 유지돼야 전환 확정          | 3초    | 1초    |
| 관측 신선도 | 이보다 오래된 관측은 비교에서 제외(현재 구역 고착 방지) | 5초    | 3초    |

- 전환이 확정되면 PostgreSQL에 판정 이력(원본)을 쌓고 Redis의 최신 위치(캐시)를 갱신. 조회는 Redis 우선, 없으면 DB 폴백이라 캐시가 유실돼도 복원 가능

### 2. NFC 동적 인증: 대여·반납

칩이 태깅마다 URL을 다시 계산해 UID, 단조 증가 읽기 카운터, 둘에 대한 CMAC을 싣는다. 경로의 토큰은 장비를, 쿼리 문자열은 그 태깅이 진짜임을 나타낸다.

```
https://mediledger.xyz/nfc/pump-001?uid=04AABBCCDDEE80&ctr=00019A&cmac=A1B2C3D4E5F60718
```

- **키 다양화**: 마스터키 → 태그별 키(UID로 유도) → 세션 키(UID·카운터로 유도)의 3계층. 태그별 키가 노출돼도 다른 태그나 마스터키를 유도할 수 없음. 마스터키는 서버 설정으로만 주입하고, 어떤 키도 DB에 저장하지 않음
- **서버 검증**: 아래 순서를 모두 통과하면 계정·장비에 묶인 1회용 태깅 세션(3분)을 발급. 대여·반납은 이 세션을 소비해야만 처리됨

<img src="assets/readme/nfc-verification.png" alt="서버의 태깅 검증 절차" width="55%">

| 검증          | 막는 공격                         |
| ----------- | ----------------------------- |
| UID ↔ 경로 토큰 | 유효한 쿼리 문자열을 다른 장비 URL에 붙이는 위조 |
| CMAC(상수 시간 비교) | 태그 복제·위조, 타이밍 부채널             |
| 읽기 카운터(원자적 비교·갱신) | 캡처한 URL 재전송, 동시 요청 경쟁 상태      |

- 장비를 특정할 수 있는 거부(`cmac_mismatch`, `counter_replay`, `uid_token_mismatch`)는 `usage_nfc_events`에 감사 기록으로 남김. 쿼리 문자열 없이 `/nfc/pump-001`로 들어오면 화면조차 열리지 않음
- 칩이 없는 시뮬레이션 태그는 `tags.is_real_hardware = FALSE`일 때만 세션 요구에서 면제. 역할·계정·헤더로는 면제를 얻을 수 없음
- 대여 시 대여자는 로그인 계정, 시각은 서버 시각, 위치는 판정 구역으로 채워지므로 요청을 조작해 남의 명의나 임의 시각으로 기록할 수 없음. 장비별 미완료 이력은 DB 제약으로 하나만 허용해 동시 대여를 차단
- 반납 시 대여~반납 사이의 위치 전환 이력을 이어 이동 경로를 만들고 블록체인에 기록

### 3. 블록체인 기록과 4계층 무결성 검증

- 블록체인에는 검증에 필요한 항목만 기록: 이력 ID, 대여자·반납자 계정 ID, 태그 ID, 대여·반납 시각과 위치, 이동 경로, 기록 시각
- 이름·직책·소속과 장비명·종류·NFC 토큰은 기록하지 않음. 사용자는 계정 ID로만 남음
- 컨트랙트 `UsageRecordRegistry`는 지정된 기록 계정만 쓰기를 허용하고 같은 이력 ID의 재기록을 막아, 최초 기록을 검증 기준으로 유지

<img src="assets/readme/integrity-verification.png" alt="사용 이력 조회와 무결성 검증 과정" width="65%">

관리자가 이력을 조회할 때마다 서버가 DB 원본을 서로 다른 근거 네 가지와 대조한다. 넷을 모두 일관되게 위조하지 않는 한 검증을 통과할 수 없다.

| 계층      | 대조 대상                            | 확인 사항            |
| ------- | -------------------------------- | ---------------- |
| 컨트랙트 상태 | DB 원본 ↔ 컨트랙트에 저장된 레코드            | 현재 저장값과 원본의 일치   |
| 트랜잭션 서명 | 서명에서 복원한 발신자 ↔ 기록 당시 허용된 기록 계정   | 기록 주체의 정당성       |
| 트랜잭션 입력 | DB 원본 ↔ 트랜잭션 입력에서 복원한 호출 인자      | 기록 당시 제출값과 원본의 일치 |
| 블록 포함   | 블록 헤더의 transactionsRoot ↔ 재계산 값, 블록 내 순번 | 트랜잭션의 블록 포함 여부   |

관리자 화면은 이력마다 `검증 완료` 또는 불일치 사유(온체인 원문 불일치, 머클루트 불일치 등)를 표시하고, 이력별 검증 증명서 인쇄(PDF 저장)와 조회 결과 CSV 내보내기를 지원한다.

---

## 평가

### 측위 정확도

가상 병원(구역 42, 장비 50대)의 24시간 신호(실제 구역 전환 455회)에 판정 파라미터를 스윕해 설정을 고르고, 그 설정의 성능을 측정했다. 도구와 수치는 `eval/`에 있다.

| 지표      | 결과                    |
| ------- | --------------------- |
| 정지 정확도  | **99.23%**            |
| 오전환     | 장비 1대당 시간당 0.094회     |
| 전환 지연   | 중앙값 2초, 95백분위수 7초      |
| 경로 정밀도  | 95.36%                |
| 누락 전환   | 455회 중 112회(24.6%) |

### 무결성 검증

공격자를 침해 범위에 따라 세 등급으로 나누고, 14개 시나리오를 서로 다른 이력으로 10회씩 반복했다. 반복 간 판정은 모두 같았다.

| 등급 | 공격자            | 공격 능력                    |
| -- | -------------- | ------------------------ |
| A  | DB 접근 내부자      | 사용 이력 변조                 |
| B  | DB 관리 권한 보유자   | A + 블록체인 기록 메타데이터(트랜잭션 해시, 블록 번호) 변조 |
| C  | RPC 노드 장악      | B + 블록체인 조회 응답 위조         |

- **변조 탐지 8종**: 변조된 이력을 `검증 완료`로 위장하려는 은폐 시도는 모든 등급에서 탐지됨
- **정상 확인 2종**: 표시용 항목(장비명) 변조, 블록 번호 변조는 검증 대상이 아니거나 영수증으로 블록을 다시 찾으므로 `검증 완료` 유지
- **한계 4종**: RPC 노드를 장악한 공격자가 정상 이력을 불일치로 보이게 하는 훼손은 막지 못함

---

## 한계와 향후 과제

- 측위 평가는 경로 손실·벽 감쇠·잡음을 확률적으로 모사한 신호로 수행해 실제 병원으로 일반화하기 어려움
- NFC 인증은 유효한 태그 응답만 증명할 뿐 태그와 장비의 물리적 결합이나 거리를 증명하지 않음 → 태그 이식·릴레이 공격에 대응 불가. 대칭 키 CMAC이라 부인 방지 없음
- 태깅 없이 장비를 쓰면 기록이 누락됨 → 대여 상태가 아닌 장비의 구역 이동을 탐지해 확인 요청하는 방안
- 검증이 단일 RPC 노드 응답에 의존하고, 병원이 서버·기록 키·검증 노드를 모두 운영해 외부 분쟁 상대에 대한 증거 독립성이 없음 → 복수 노드 교차 검증, 합의 서명을 검증한 블록 헤더 기준 머클 증명
- 병원·공공기관·장비 제조사가 검증 노드를 나눠 운영하는 컨소시엄 블록체인으로 확장. QBFT는 검증 노드 `3f+1`개로 장애·악의 노드 `f`개를 허용(4개 → 1개, 7개 → 2개, 10개 → 3개)

---

## 가상 병원 시뮬레이션

실물 리더는 2대(M501 중앙수술센터, M502 통원수술센터)뿐이라, 순천향대학교 천안병원 본관 1~5층을 바탕으로 한 가상 병원을 상시 가동해 규모가 필요한 검증(판정 임계값, 다층 도면, 이력 조회, 블록체인 기록 처리량)을 한다.

| 대상     | 규모                                        |
| ------ | ----------------------------------------- |
| 구역(리더) | 42개 (본관 1~5층, 실물 담당 구역 제외)                |
| 장비(태그) | 20종 50대 (수액펌프·제세동기·초음파진단기 등 이동형 의료기기)     |
| 의료진    | 120명 (직종·담당 층별, 3교대 또는 평일 상근·온콜)          |

- **서버는 시뮬레이터를 모름**: 실물 리더와 같은 HTTP 규격(`/ingest`, `/auth/login`, `/usage/checkout`, `/usage/return`)만 호출하는 클라이언트라, 시뮬레이터로 검증한 동작이 곧 실물 경로의 검증. 실물과의 구분은 데이터(`is_real_hardware`, 태그 major `1`=실물·`2`=시뮬레이션)로만 함
- **전파 모델**: `RSSI(d) = -59 - 20·log10(d) - 6·(벽 홉 수) + 태그 개체차 + 잡음`. 벽 홉 수는 구역 인접 그래프의 최단 홉으로 근사
- **이동·수요**: 인접 그래프 최단 경로를 평균 1.1 m/s로 이동. 급성기·외래 장비별 시간대·요일 수요 곡선, 중환자실·분만실의 만성 부족 장비 5종, 엉뚱한 위치 반납·대리 반납 같은 예외 이벤트 포함
- 상세: [`simulation/README.md`](simulation/README.md)

---

## 실행

로컬은 하이브리드 구성이다. DB·Redis·Besu는 컨테이너, 앱은 호스트에서 돈다. 저장소 루트에서 한 줄로 인프라 → 스키마·실물 리더 등록·시뮬레이션 재시드 → 백엔드(:8000) → 프론트엔드(:5173) → 시뮬레이터까지 기동된다.

```bash
bash scripts/dev-up.sh
```

- 필요: Docker, 호스트의 `psql`, 저장소 루트의 `.venv`, 루트 `.env`와 `simulation/.env`(`.env.example` 참고, 두 파일의 `RTLS_SIM_KEY`는 같아야 함)
- 다시 실행하면 인프라는 그대로 두지만, 백엔드·시뮬레이터를 재기동하고 시뮬레이션 데이터와 Redis 위치 캐시를 지운 뒤 다시 넣음(실물 데이터는 유지)
- 정지: 앱 프로세스를 종료하고 `docker-compose -f docker-compose.dev.yml down` (`-v`는 DB 볼륨까지 지우므로 금지)
- 로그: `.logs/backend.log` · `frontend.log` · `simulator.log`

<details>
<summary>구성 요소별 실행</summary>

**최초 1회**

```bash
bash blockchain/besu/scripts/generate-network.sh   # genesis, 검증자 키, blockchain/besu/.env
docker-compose -f docker-compose.dev.yml up -d     # postgres · redis · besu(4+1)
psql "$DATABASE_URL" -f database/schema.sql
cd blockchain/besu && npm install && node scripts/deploy-usage-registry.mjs && cd -
```

- DB는 named volume에 영속, 접속 `postgresql://mediledger:mediledger@localhost:5432/mediledger_db`
- RPC 엔드포인트 `http://127.0.0.1:8549` (chain ID 1337, QBFT)

**백엔드** (저장소 루트)

```bash
pip install -r backend/requirements.txt
uvicorn backend.server:app --host 0.0.0.0 --port 8000
```

**프론트엔드** (`frontend/`)

```bash
npm install
npm run dev
```

**가상 병원 시뮬레이터** (저장소 루트, 하드웨어 불필요)

```bash
python -m simulation.apply_seed   # 시뮬레이션 데이터 재시드
python -m simulation.simulator
```

**RTLS 엣지** (`rtls/`, BLE 하드웨어 필요) — 리더 설정은 [`rtls/README.md`](rtls/README.md)

```bash
pip install -r requirements.txt
python rtls_reader/send_to_server.py   # RSSI 스캔 후 서명해 /ingest로 전송
```

</details>

---

## 시스템 구성

Compose 파일은 3개이고, 블록체인 스택만 공유한다.

```
              blockchain/besu/docker-compose.yml
              (validator1~4 · rpc-node)
                     ▲                ▲
             include │                │ include
                     │                │
      docker-compose.dev.yml    docker-compose.yml
      (로컬 개발)                (운영 서버 배포)
```

- **로컬 개발**: postgres · redis · besu만 컨테이너, backend · frontend는 호스트에서 실행(hot-reload)
- **운영 서버**: postgres · redis · backend · web(nginx) · simulator · besu · cloudflared를 모두 컨테이너로 실행. Cloudflare 터널로 `mediledger.xyz`를 연결하며 포트를 열지 않음
- `main`에 push하면 GitHub Actions가 테스트 후 backend · web · simulator 이미지를 GHCR에 올리고, `DEPLOY_READY`가 켜져 있으면 운영 서버에 배포(`.github/workflows/deploy.yml`). 스키마는 자동 적용되지 않음
- `simulator`는 포트를 열지 않고 내부 네트워크로 `backend`에만 요청하는 클라이언트. 검증 노드도 호스트 포트를 열지 않음
- `blockchain/besu/`에서 `docker compose up -d`로 블록체인만 단독 기동 가능

---

## 코드 품질

- **Python**: Ruff로 린트·포맷(`pyproject.toml`), 저장소 루트에서 `pytest`. 개발 의존성은 `pip install -r requirements-dev.txt`
- **JS/TS**: ESLint + Prettier, `npm run lint`. 프론트엔드 테스트는 `frontend/`에서 `npm run test`
- **커밋 훅**: Husky + lint-staged가 스테이징된 파일만 검사·수정
- **PR 검사**: `main` 대상 PR에서 GitHub Super-Linter가 변경 파일 재검증
