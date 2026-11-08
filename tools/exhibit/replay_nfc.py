"""NFC 태그 복제·재전송 차단 실연. 이미 쓴 태깅 URL로 운영 /nfc에 두 번 공격한다.

  python -m tools.exhibit.replay_nfc "https://mediledger.xyz/nfc/pump-001?uid=…&ctr=…&cmac=…"

- 재전송: 한 번 쓰인 URL을 그대로 보낸다 → 카운터 재사용으로 거부
- 위조: 카운터만 올리고 CMAC은 그대로 둔다 → 칩 키 없이는 CMAC을 못 만들어 거부
- 거부는 운영 usage_nfc_events에 rejected 1행씩 남고, ssh로 그 감사 기록을 보여 준다
"""

import argparse
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

import requests

from tools.exhibit.common import (
    DEFAULT_API,
    DEFAULT_REMOTE_DIR,
    DEFAULT_SSH_HOST,
    HTTP_TIMEOUT_SEC,
    Remote,
    RemoteError,
    auth,
    bad,
    demo_login,
    detail_of,
    dim,
    good,
    line,
    section,
    title,
)

REJECTION_REASONS = {
    "counter_replay": "이미 사용된 카운터",
    "cmac_mismatch": "CMAC 불일치",
    "uid_token_mismatch": "다른 장비의 URL",
}


@dataclass(frozen=True)
class TapUrl:
    token: str
    uid: str
    ctr: str
    cmac: str


@dataclass(frozen=True)
class Attempt:
    title: str
    explain: str
    token: str
    query: dict[str, str]


def parse_tap_url(url: str) -> TapUrl:
    parts = urlsplit(url)
    segments = [segment for segment in parts.path.split("/") if segment]
    query = {key: values[0] for key, values in parse_qs(parts.query).items()}
    if len(segments) < 2 or segments[-2] != "nfc" or not all(query.get(key) for key in ("uid", "ctr", "cmac")):
        raise SystemExit("칩이 만든 태깅 URL(/nfc/<토큰>?uid=…&ctr=…&cmac=…)을 넣어 주세요.")
    return TapUrl(token=segments[-1], uid=query["uid"], ctr=query["ctr"], cmac=query["cmac"])


def next_counter(ctr: str) -> str:
    return f"{int(ctr, 16) + 1:0{len(ctr)}X}"


def build_attempts(tap: TapUrl) -> list[Attempt]:
    forged_ctr = next_counter(tap.ctr)
    return [
        Attempt(
            "재전송",
            f"이미 한 번 쓰인 태깅 URL(카운터 {tap.ctr})을 그대로 다시 전송",
            tap.token,
            {"uid": tap.uid, "ctr": tap.ctr, "cmac": tap.cmac},
        ),
        Attempt(
            "복제 URL 위조",
            f"카운터만 {tap.ctr} → {forged_ctr}로 올리고 CMAC은 그대로 둔 URL",
            tap.token,
            {"uid": tap.uid, "ctr": forged_ctr, "cmac": tap.cmac},
        ),
    ]


def _show_audit(remote: Remote, count: int) -> None:
    section(count + 1, "서버 감사 기록 (usage_nfc_events)")
    try:
        rows = remote.psql(
            "SELECT to_char(occurred_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI:SS'), reason "
            f"FROM usage_nfc_events WHERE result = 'rejected' ORDER BY occurred_at DESC LIMIT {int(count)};"
        ).splitlines()
    except RemoteError:
        line(dim("운영 서버에 접속하지 못해 감사 기록 조회를 건너뜀"))
        return
    for row in reversed(rows):
        at, _, reason = row.partition("|")
        line(f"{at}  rejected  {reason}  {dim(REJECTION_REASONS.get(reason, ''))}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="NFC 태그 복제·재전송 차단 실연(운영 /nfc)")
    parser.add_argument("url", help="이미 한 번 쓰인 태깅 URL")
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--ssh-host", default=DEFAULT_SSH_HOST)
    parser.add_argument("--remote-dir", default=DEFAULT_REMOTE_DIR)
    parser.add_argument("--no-audit", action="store_true", help="ssh 감사 기록 조회를 건너뜀")
    args = parser.parse_args(argv)

    tap = parse_tap_url(args.url)
    attempts = build_attempts(tap)
    title("NFC 태그 복제·재전송 차단", f"{args.api}/nfc/{tap.token}")
    token = demo_login(args.api, "staff")

    blocked = 0
    for number, attempt in enumerate(attempts, start=1):
        section(number, attempt.title)
        line(dim(attempt.explain))
        response = requests.get(
            f"{args.api}/nfc/{attempt.token}", params=attempt.query, headers=auth(token), timeout=HTTP_TIMEOUT_SEC
        )
        if response.status_code >= 400:
            blocked += 1
            line(good(f"→ {response.status_code} {detail_of(response)} · 차단"))
        else:
            line(bad(f"→ {response.status_code} 태깅 세션 발급 · 차단 실패"))

    if not args.no_audit:
        _show_audit(Remote(args.ssh_host, args.remote_dir), len(attempts))
    print()
    line(f"결과  공격 {len(attempts)}건 중 {blocked}건 차단")
    return 0 if blocked == len(attempts) else 1


if __name__ == "__main__":
    raise SystemExit(main())
