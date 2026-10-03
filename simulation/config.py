"""배포 설정만 담는다 — URL, 비밀, 타임아웃, 난수 시드.

전파·수요·행동 모델의 튜닝 상수는 각 모듈(radio.py, demand.py, behavior.py, world.py)에
있다. 그 모듈만 열면 모델이 전부 보이고, 단위 테스트가 환경변수에 의존하지 않는다.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# 로컬 실행 시 simulation/.env에서 읽는다. 홈서버 컨테이너에서는 이 파일이 이미지에
# 없으므로 조용히 무시되고, docker-compose가 주입한 OS 환경변수가 그대로 쓰인다.
load_dotenv(Path(__file__).resolve().parent / ".env")

BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://127.0.0.1:8000")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://mediledger:mediledger@localhost:5432/mediledger_db")
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
SIM_STAFF_PASSWORD = os.getenv("SIM_STAFF_PASSWORD")
RTLS_SIM_KEY = os.getenv("RTLS_SIM_KEY", "")

HTTP_TIMEOUT_SEC = float(os.getenv("SIM_HTTP_TIMEOUT_SEC", "10"))
INGEST_TIMEOUT_SEC = float(os.getenv("SIM_INGEST_TIMEOUT_SEC", "5"))
# 반납은 온체인 앵커링을 트리거해 Besu 블록 주기만큼 블로킹된다.
RETURN_HTTP_TIMEOUT_SEC = float(os.getenv("RETURN_HTTP_TIMEOUT_SEC", "40"))

# 비우면 시스템 엔트로피를 쓴다. 값을 주면 매 기동이 같은 궤적을 그린다(디버깅용).
_seed = os.getenv("SIM_RANDOM_SEED")
SIM_RANDOM_SEED = int(_seed) if _seed else None
