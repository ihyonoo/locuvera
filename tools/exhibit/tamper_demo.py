"""사용 이력 변조 탐지 실연. 운영 DB의 연출 기록 1건을 잠시 변조하고 검증이 잡는지 보인 뒤 되돌린다.

  python -m tools.exhibit.tamper_demo            # 기본: 이력 3251, 반납 시각 2시간 늦춤, 45초 뒤 복구
  python -m tools.exhibit.tamper_demo --restore  # 지난 실행이 복구하지 못했을 때

- DB 관리자 권한을 가진 공격자를 가정해 usage_history.returned_at만 바꾼다
- 체인 기록은 읽기만 한다
- 원래 값은 변조 전에 ~/.locuvera-exhibit/<id>.json에 남기고, 정상 종료·Ctrl+C·예외·터미널 닫힘 모두 복구한다
- ssh로 운영 서버에 붙으므로 노트북이 Tailscale에 접속해 있어야 한다
"""

import argparse
import json
import re
import signal
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

import requests

from tools.exhibit.common import (
    DEFAULT_API,
    DEFAULT_REMOTE_DIR,
    DEFAULT_SSH_HOST,
    Remote,
    RemoteError,
    auth,
    bad,
    bold,
    demo_login,
    dim,
    good,
    kst,
    line,
    section,
    title,
)

# 시연 영상용으로 남긴 연출 기록(수액펌프-001, 경유 3구역)
DEFAULT_USAGE_ID = 3251
DEFAULT_HOLD_SEC = 45
DEFAULT_SHIFT_HOURS = 2
BACKUP_DIR = Path.home() / ".locuvera-exhibit"
VERIFY_TIMEOUT_SEC = 60
# psql이 내주는 timestamptz 글자 그대로만 SQL에 넣는다
TIMESTAMP_TEXT = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?")
FIELD_NAMES = {
    "returnedAt": "반납 시각",
    "checkoutAt": "대여 시각",
    "checkoutUserId": "대여자",
    "returnUserId": "반납자",
    "movementPath": "이동 경로",
    "checkoutLocation": "대여 위치",
    "returnLocation": "반납 위치",
    "tagId": "장비 태그",
}


@dataclass(frozen=True)
class UsageSnapshot:
    usage_id: int
    equipment_name: str
    returned_at: str
    # 체인에 앵커링되는 값과 같은 반올림 초(EXTRACT(EPOCH …)::BIGINT)
    returned_epoch: int
    checkout_date: str


def _checked(original: str) -> str:
    if not TIMESTAMP_TEXT.fullmatch(original):
        raise ValueError(f"반납 시각 형식이 아님: {original!r}")
    return original


# 늦춘다 — 앞당기면 짧은 기록은 returned_at >= checkout_at 제약(usage_history_return_time_valid)에 걸린다
def tamper_sql(usage_id: int, original: str, shift_hours: int) -> str:
    return (
        f"UPDATE usage_history SET returned_at = '{_checked(original)}'::timestamptz "
        f"+ interval '{int(shift_hours)} hours' WHERE usage_id = {int(usage_id)} AND usage_status = 'returned';"
    )


def restore_sql(usage_id: int, original: str) -> str:
    return (
        f"UPDATE usage_history SET returned_at = '{_checked(original)}'::timestamptz "
        f"WHERE usage_id = {int(usage_id)} AND usage_status = 'returned';"
    )


def backup_path_for(usage_id: int) -> Path:
    return BACKUP_DIR / f"{int(usage_id)}.json"


class Tamper:
    """변조를 걸고, 블록을 어떻게 빠져나가든 원래 값으로 되돌린다."""

    def __init__(self, run_sql: Callable[[str], str], snapshot: UsageSnapshot, shift_hours: int, backup_path: Path):
        self.run_sql = run_sql
        self.snapshot = snapshot
        self.shift_hours = shift_hours
        self.backup_path = backup_path

    def __enter__(self) -> "Tamper":
        # 원래 값을 먼저 남겨야 복구가 실패해도 --restore로 되돌릴 수 있다
        self.backup_path.parent.mkdir(parents=True, exist_ok=True)
        self.backup_path.write_text(json.dumps(asdict(self.snapshot), ensure_ascii=False))
        try:
            self.run_sql(tamper_sql(self.snapshot.usage_id, self.snapshot.returned_at, self.shift_hours))
        except BaseException:
            # 서버에서는 커밋됐는데 응답만 끊겼을 수 있다
            self.restore()
            raise
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.restore()
        return False

    def restore(self) -> None:
        self.run_sql(restore_sql(self.snapshot.usage_id, self.snapshot.returned_at))
        self.backup_path.unlink(missing_ok=True)


def load_snapshot(remote: Remote, usage_id: int) -> UsageSnapshot:
    raw = remote.psql(
        "SELECT json_build_object('usage_id', usage_id, 'equipment_name', equipment_name, "
        "'returned_at', returned_at::text, 'returned_epoch', extract(epoch FROM returned_at)::bigint, "
        "'checkout_date', checkout_at::date::text) "
        f"FROM usage_history WHERE usage_id = {int(usage_id)} AND usage_status = 'returned';"
    )
    if not raw:
        raise SystemExit(f"반납 완료된 이력 {usage_id}을(를) 찾지 못했습니다.")
    return UsageSnapshot(**json.loads(raw))


def current_return_epoch(remote: Remote, usage_id: int) -> int:
    sql = f"SELECT extract(epoch FROM returned_at)::bigint FROM usage_history WHERE usage_id = {int(usage_id)};"
    return int(remote.psql(sql))


def fetch_verification(api: str, token: str, snapshot: UsageSnapshot) -> dict:
    """화면과 같은 이력 조회 API로 이 1건만 다시 검증한다."""
    response = requests.get(
        f"{api}/usage/history",
        params={
            "equipment": snapshot.equipment_name,
            "date": snapshot.checkout_date,
            "include_blockchain": "true",
            "limit": 50,
        },
        headers=auth(token),
        timeout=VERIFY_TIMEOUT_SEC,
    )
    response.raise_for_status()
    for item in response.json().get("items", []):
        if item.get("usage_id") == snapshot.usage_id:
            return item.get("blockchain") or {}
    raise SystemExit(f"검증 응답에서 이력 {snapshot.usage_id}을(를) 찾지 못했습니다.")


def show_verification(result: dict) -> bool:
    verified = result.get("verification_status") == "verified"
    label = result.get("verification_label") or result.get("verification_status") or "알 수 없음"
    fields = [FIELD_NAMES.get(field, field) for field in result.get("mismatch_fields") or []]
    suffix = f" · 불일치 항목: {', '.join(fields)}" if fields else ""
    line((good if verified else bad)(f"→ {label}{suffix}"))
    return verified


def countdown(seconds: int) -> None:
    for remaining in range(seconds, 0, -1):
        print(f"\r    {dim(f'{remaining:>3}초 뒤 자동 복구')}", end="", flush=True)
        time.sleep(1)
    print("\r" + " " * 40 + "\r", end="", flush=True)


def _raise_interrupt(signum, frame):
    raise KeyboardInterrupt


def run_demo(args, remote: Remote) -> int:
    snapshot = load_snapshot(remote, args.usage_id)
    title("사용 이력 변조 탐지", f"이력 #{snapshot.usage_id} {snapshot.equipment_name} · 운영 서버")
    token = demo_login(args.api, "admin")

    section(1, "블록체인 기록 조회 (읽기 전용)")
    chain = remote.read_chain_record(snapshot.usage_id)
    line(f"체인의 반납 시각   {kst(chain['returnedAt'])}")

    section(2, "데이터베이스 원본")
    line(f"DB의 반납 시각     {kst(snapshot.returned_epoch)}")
    if not show_verification(fetch_verification(args.api, token, snapshot)):
        backup = backup_path_for(snapshot.usage_id)
        hint = " 지난 실행이 남긴 변조일 수 있으니 --restore로 되돌리세요." if backup.exists() else ""
        line(bad(f"시작 전부터 검증에 실패해 실연을 멈춥니다.{hint}"))
        return 1

    with Tamper(remote.psql, snapshot, args.shift_hours, backup_path_for(snapshot.usage_id)):
        section(3, f"변조: DB 관리자 권한으로 반납 시각을 {args.shift_hours}시간 늦춤")
        shown_sql = f"UPDATE usage_history SET returned_at = returned_at + {args.shift_hours}h"
        line(dim(f"{shown_sql} WHERE usage_id = {snapshot.usage_id}"))
        line(f"DB의 반납 시각     {bad(kst(current_return_epoch(remote, snapshot.usage_id)))}  (체인과 다름)")

        section(4, "무결성 검증")
        show_verification(fetch_verification(args.api, token, snapshot))
        line(dim(f"웹 검증 화면에서 #{snapshot.usage_id}을 새로 고쳐 확인"))
        countdown(args.hold)

        section(5, "원상 복구")
    line(f"DB의 반납 시각     {kst(current_return_epoch(remote, snapshot.usage_id))}")
    restored = show_verification(fetch_verification(args.api, token, snapshot))
    print()
    summary = "변조 즉시 탐지 · 원래 값으로 복구 완료" if restored else "복구 후에도 검증 실패 — 확인 필요"
    line(bold(f"결과  {summary}"))
    return 0 if restored else 1


def run_restore(args, remote: Remote) -> int:
    backup = backup_path_for(args.usage_id)
    if not backup.exists():
        line(f"남은 백업이 없습니다({backup}). 되돌릴 변조가 없습니다.")
        return 0
    snapshot = UsageSnapshot(**json.loads(backup.read_text()))
    Tamper(remote.psql, snapshot, args.shift_hours, backup).restore()
    line(good(f"이력 #{snapshot.usage_id} 반납 시각을 {kst(snapshot.returned_epoch)}로 복구"))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="사용 이력 변조 탐지 실연(운영 DB, 자동 복구)")
    parser.add_argument("--usage-id", type=int, default=DEFAULT_USAGE_ID)
    parser.add_argument("--hold", type=int, default=DEFAULT_HOLD_SEC, help="변조를 유지하는 초")
    parser.add_argument("--shift-hours", type=int, default=DEFAULT_SHIFT_HOURS)
    parser.add_argument("--restore", action="store_true", help="남은 백업으로 원래 값을 되돌림")
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--ssh-host", default=DEFAULT_SSH_HOST)
    parser.add_argument("--remote-dir", default=DEFAULT_REMOTE_DIR)
    args = parser.parse_args(argv)

    # 터미널을 닫거나 종료 신호가 와도 Ctrl+C처럼 복구 경로를 탄다
    signal.signal(signal.SIGTERM, _raise_interrupt)
    signal.signal(signal.SIGHUP, _raise_interrupt)
    remote = Remote(args.ssh_host, args.remote_dir)
    try:
        return run_restore(args, remote) if args.restore else run_demo(args, remote)
    except (RemoteError, KeyboardInterrupt) as exc:
        print()
        line(bad("중단됨" if isinstance(exc, KeyboardInterrupt) else f"운영 서버 명령 실패: {exc}"))
        if backup_path_for(args.usage_id).exists():
            line(bad("변조가 남았을 수 있습니다. 연결을 확인한 뒤 --restore로 되돌리세요."))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
