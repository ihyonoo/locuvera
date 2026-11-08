"""학술제 실연 스크립트 공통: 운영 API 데모 로그인, 운영 서버 원격 실행, 터미널 출력."""

import json
import os
import shlex
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import requests

DEFAULT_API = "https://mediledger.xyz/api"
# 운영 서버 ssh 별칭과 compose 프로젝트 경로(deploy/deployment.md)
DEFAULT_SSH_HOST = "deepi-personal-dev-server"
DEFAULT_REMOTE_DIR = "/home/hwdev/project/mediledger"
HTTP_TIMEOUT_SEC = 20
REMOTE_TIMEOUT_SEC = 90
KST = timezone(timedelta(hours=9))

# 터미널이면 색을 쓴다. 촬영처럼 출력을 파이프로 받을 때는 FORCE_COLOR=1
_COLOR = sys.stdout.isatty() or os.getenv("FORCE_COLOR") == "1"


def _paint(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def bold(text: str) -> str:
    return _paint("1", text)


def dim(text: str) -> str:
    return _paint("2", text)


def good(text: str) -> str:
    return _paint("32", text)


def bad(text: str) -> str:
    return _paint("31", text)


def title(text: str, target: str) -> None:
    print()
    print(bold(f"━━ {text} ━━"))
    print(dim(f"대상 {target}"))


def section(number: int, text: str) -> None:
    print()
    print(bold(f"[{number}] {text}"))


def line(text: str = "") -> None:
    print(f"    {text}")


def kst(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, KST).strftime("%Y-%m-%d %H:%M:%S")


def demo_login(api: str, role: str) -> str:
    """공개 데모 계정 토큰. 데모 계정은 계정·매핑 변경이 막혀 있다."""
    response = requests.post(f"{api}/auth/demo-login", json={"role": role}, timeout=HTTP_TIMEOUT_SEC)
    response.raise_for_status()
    return response.json()["token"]


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def detail_of(response: requests.Response) -> str:
    try:
        detail = response.json().get("detail")
    except ValueError:
        detail = None
    return detail if isinstance(detail, str) else response.reason


class RemoteError(RuntimeError):
    pass


class Remote:
    """운영 서버 compose 컨테이너에 ssh로 명령을 보낸다. 노트북이 Tailscale에 붙어 있어야 한다."""

    def __init__(self, host: str = DEFAULT_SSH_HOST, project_dir: str = DEFAULT_REMOTE_DIR, run=subprocess.run):
        self.host = host
        self.project_dir = project_dir
        self._run = run

    def _exec(self, remote_cmd: str, stdin: str | None = None) -> str:
        try:
            result = self._run(
                ["ssh", self.host, f"cd {shlex.quote(self.project_dir)} && {remote_cmd}"],
                input=stdin,
                capture_output=True,
                text=True,
                timeout=REMOTE_TIMEOUT_SEC,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RemoteError(f"운영 서버 명령 실패: {exc}") from exc
        if result.returncode != 0:
            raise RemoteError(result.stderr.strip() or f"운영 서버 명령 실패(종료 코드 {result.returncode})")
        return result.stdout.strip()

    def psql(self, sql: str) -> str:
        # SQL은 인자가 아니라 표준 입력으로 넘긴다 — 원격 셸 따옴표를 거치지 않는다
        psql = shlex.quote('psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1')
        return self._exec(f"docker compose exec -T postgres sh -c {psql}", stdin=sql)

    def read_chain_record(self, usage_id: int) -> dict:
        """체인에 앵커링된 사용 기록(읽기 전용 조회)."""
        raw = self._exec(
            f"docker compose exec -T -w /app/blockchain/besu backend node scripts/read-usage-record.mjs {int(usage_id)}"
        )
        return json.loads(raw)
