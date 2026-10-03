# backend

Locuvera의 FastAPI + PostgreSQL API 서버.

## 설치

```bash
pip install -r backend/requirements.txt
```

## DB 스키마 적용

```bash
psql "$DATABASE_URL" -f database/schema.sql
```

`schema.sql`은 `CREATE TABLE IF NOT EXISTS` 기반이라 멱등적으로 여러 번 실행해도 안전하다.

## 실행

**반드시 저장소 루트에서 실행한다** (`__main__` 블록이 없으므로 항상 uvicorn으로 실행).

```bash
uvicorn backend.server:app --reload                        # :8000
uvicorn backend.server:app --host 0.0.0.0 --port 8000       # LAN(리더/기기) 접근용
```

## 테스트

```bash
pip install -r requirements-dev.txt   # 저장소 루트에서
```

통합 테스트는 실제 Postgres에 붙는다. 최초 1회, 개발용 DB와 분리된 테스트 전용 DB를 만들고 스키마를 적용한다.

```bash
psql "postgresql://mediledger:mediledger@localhost:5432/mediledger_db" -c "CREATE DATABASE mediledger_test_db OWNER mediledger"
psql "postgresql://mediledger:mediledger@localhost:5432/mediledger_test_db" -f database/schema.sql
```

실행(저장소 루트에서):

```bash
pytest
```

`backend/tests/conftest.py`가 매 테스트 전에 `mediledger_test_db`의 관련 테이블을 TRUNCATE하고 서버 메모리 상태(`tag_obs`/`tag_state`)를 리셋한다 — 개발용 DB(`mediledger_db`)는 건드리지 않는다.

## 환경 변수

저장소 루트 `.env`를 `settings.py`가 읽는다. 주요 키:

- `DATABASE_URL`, `REDIS_URL`
- `CORS_ALLOW_ORIGINS`
- `AUTH_TOKEN_SECRET`, `AUTH_TOKEN_TTL_SEC`
- `RTLS_REAL_READER_KEYS` — 실물 리더 ID별 서명 키의 JSON 객체
- `RTLS_SIM_KEY` — 시뮬레이터 요청 서명 키. `simulation/.env`와 동일한 값
- `SMTP_*` — 비워두면 이메일 발송 대신 `.logs/backend.log`에 링크 출력(dev 폴백)
- `GOOGLE_CLIENT_*`, `APP_PUBLIC_URL` — 비워두면 Google OAuth 비활성
- `DEMO_LOGIN_ENABLED` — 기본 켜짐. `false`로 두면 `/auth/demo-login`이 404가 된다(로그인 화면의 데모 체험 버튼 무력화)

## 관련 문서

- [CLAUDE.md](CLAUDE.md) — 아키텍처, 모듈 구성, import 규약
- [database/](../database/README.md) — 스키마
- [blockchain/besu/](../blockchain/besu/README.md) — 백엔드가 subprocess로 호출하는 앵커링 스크립트
