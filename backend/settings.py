import json
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv

# 백엔드는 저장소 루트의 .env를 기준으로 읽는다.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:9124@localhost:5432/rtls",
)
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
RTLS_SIM_KEY = os.getenv("RTLS_SIM_KEY", "")
try:
    RTLS_REAL_READER_KEYS = json.loads(os.getenv("RTLS_REAL_READER_KEYS", "{}"))
    if not isinstance(RTLS_REAL_READER_KEYS, dict):
        RTLS_REAL_READER_KEYS = {}
except json.JSONDecodeError:
    RTLS_REAL_READER_KEYS = {}
BESU_DIR = Path(__file__).resolve().parents[1] / "blockchain" / "besu"
BESU_DEPLOYMENT_PATH = BESU_DIR / "deployments" / "usage-registry.json"
AUTH_TOKEN_SECRET = os.getenv("AUTH_TOKEN_SECRET", "dev-auth-secret")
AUTH_TOKEN_TTL_SEC = max(300, int(os.getenv("AUTH_TOKEN_TTL_SEC", "43200")))

# NTAG 424 DNA 마스터키(AES-128, hex 32자). 태그별 키는 여기서 UID로 파생하며 DB에 두지 않는다.
# 비어 있으면 실물 태그 검증만 닫히고(503) 위치추적·이력·시뮬레이터는 그대로 돈다.
# 분실하면 개인화된 모든 태그를 영구히 못 쓴다 — 저장소 바깥에 백업해 둘 것.
NTAG_MASTER_KEY_HEX = os.getenv("NTAG_MASTER_KEY", "").strip()
NTAG_MASTER_KEY = bytes.fromhex(NTAG_MASTER_KEY_HEX) if re.fullmatch(r"[0-9A-Fa-f]{32}", NTAG_MASTER_KEY_HEX) else None
if NTAG_MASTER_KEY is None:
    # 조용히 넘어가면 실물 태그가 전부 503으로 거부되는 이유를 아무도 모른 채 운영된다.
    logging.getLogger(__name__).warning(
        "NTAG_MASTER_KEY가 없거나 형식이 잘못됐다(hex 32자). 실물 NFC 태그 검증이 비활성화된다 "
        "— 위치추적·이력·시뮬레이터는 정상 동작한다."
    )

# 회원가입 없이 둘러보는 데모 로그인 스위치. 끄면 /auth/demo-login이 404가 된다.
DEMO_LOGIN_ENABLED = os.getenv("DEMO_LOGIN_ENABLED", "true").strip().lower() not in ("0", "false", "no")

# 프론트엔드 공개 URL — 인증/재설정 메일 링크와 OAuth 콜백 이후 리다이렉트의 기준.
APP_PUBLIC_URL = os.getenv("APP_PUBLIC_URL", "http://localhost:5173").rstrip("/")

# 이메일 기반 액션 토큰(인증/재설정/OAuth handoff) 유효 시간.
EMAIL_VERIFY_TTL_SEC = max(300, int(os.getenv("EMAIL_VERIFY_TTL_SEC", "86400")))  # 기본 24h
PASSWORD_RESET_TTL_SEC = max(300, int(os.getenv("PASSWORD_RESET_TTL_SEC", "3600")))  # 기본 1h
OAUTH_STATE_TTL_SEC = max(60, int(os.getenv("OAUTH_STATE_TTL_SEC", "600")))  # 기본 10m
OAUTH_HANDOFF_TTL_SEC = max(30, int(os.getenv("OAUTH_HANDOFF_TTL_SEC", "120")))  # 기본 2m
OAUTH_PENDING_TTL_SEC = max(300, int(os.getenv("OAUTH_PENDING_TTL_SEC", "1800")))  # 기본 30m

# Gmail SMTP (앱 비밀번호). 값이 비어 있으면 email_utils가 dev 폴백(로그 출력)으로 동작한다.
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "") or SMTP_USER

# Google OAuth 2.0 (authorization code / redirect).
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI", "http://localhost:8000/auth/google/callback")

REDIS_LOCATION_KEY_PREFIX = "rtls:tag:"
REDIS_CONNECT_TIMEOUT_SEC = 0.2
REDIS_RETRY_COOLDOWN_SEC = 5
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{2,49}$")

# 실물 리더가 담당하는 구역. DB readers.location_name이 비어 있을 때만 쓰이는 폴백이며,
# 이름은 병원 시설 안내도의 구역명을 따른다(simulation/topology/zones.py의 REAL_READER_IDS와 동일).
READER_LOCATION = {
    "M501": "중앙수술센터",
    "M502": "통원수술센터",
}

HYST_DB = 10
DWELL_SEC = 3
STALE_SEC = 5
READER_OFFLINE_SEC = 10
TAG_OFFLINE_SEC = 10

BLOCKCHAIN_DEMO_BLOCKS_PATH = BESU_DIR / "examples" / "usage-record-batch-5x30-blocks.human.json"
BLOCKCHAIN_DEMO_FAILED_BLOCK_INDEX = 1
BLOCKCHAIN_DEMO_FAILED_TRANSACTION_INDEX = 25
