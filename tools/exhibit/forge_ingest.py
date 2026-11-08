"""측위 보고 위조 차단 실연. 운영 /ingest에 위조 보고 3건을 보내 모두 거부되는지 본다.

  python -m tools.exhibit.forge_ingest

- 실물 비콘 장비가 다른 실물 리더 구역에 있다고 거짓 보고한다
- 서명 없음 · 임의 키 서명 · 미등록 리더, 셋 다 서버가 거부해야 한다
- 올바른 리더 키로 서명한 요청은 보내지 않는다 — 실제 위치 판정에 닿지 않는다
"""

import argparse
import hashlib
import hmac
import json
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass

import requests

from tools.exhibit.common import (
    DEFAULT_API,
    HTTP_TIMEOUT_SEC,
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

UNREGISTERED_READER = "M999"
# 리더 바로 옆에 있는 것처럼 센 신호
FORGED_RSSI = -35


@dataclass(frozen=True)
class ForgedReport:
    title: str
    explain: str
    headers: dict[str, str]
    body: bytes


def _body(reader_id: str, tag_id: str, now: int) -> bytes:
    payload = {
        "reader_id": reader_id,
        "ts": now,
        "observations": [{"tag_id": tag_id, "rssi": FORGED_RSSI, "count": 5, "last_seen": now}],
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def _signed_headers(reader_id: str, now: int, nonce: str, body: bytes, key: str) -> dict[str, str]:
    timestamp = str(now)
    message = f"v1\n{reader_id}\n{timestamp}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode("ascii")
    return {
        "Content-Type": "application/json",
        "X-RTLS-Reader-ID": reader_id,
        "X-RTLS-Timestamp": timestamp,
        "X-RTLS-Nonce": nonce,
        "X-RTLS-Signature": hmac.new(key.encode("utf-8"), message, hashlib.sha256).hexdigest(),
    }


def build_forged_reports(
    reader_id: str,
    tag_id: str,
    now: int,
    make_nonce: Callable[[], str] = lambda: secrets.token_hex(16),
    attacker_key: str | None = None,
) -> list[ForgedReport]:
    # 공격자는 리더 키를 모른다 — 매번 새로 만든 임의 키로 서명한다
    key = attacker_key or secrets.token_hex(32)
    claimed = _body(reader_id, tag_id, now)
    unknown = _body(UNREGISTERED_READER, tag_id, now)
    return [
        ForgedReport(
            "서명 없는 보고",
            f"서명 헤더 없이 리더 {reader_id} 명의로 전송",
            {"Content-Type": "application/json"},
            claimed,
        ),
        ForgedReport(
            "위조 서명",
            f"등록된 리더 {reader_id} 사칭 · 리더 키 대신 임의 키로 HMAC 서명",
            _signed_headers(reader_id, now, make_nonce(), claimed, key),
            claimed,
        ),
        ForgedReport(
            "미등록 리더",
            f"미등록 리더 {UNREGISTERED_READER} 명의로 서명·전송",
            _signed_headers(UNREGISTERED_READER, now, make_nonce(), unknown, key),
            unknown,
        ),
    ]


def pick_target_reader(readers: list[dict], current_reader_id: str | None) -> dict:
    """받아들여지면 장비가 옮겨 가 보일 리더 — 지금 위치가 아닌 실물 리더."""
    if not readers:
        raise SystemExit("실물 리더가 없어 위조 대상을 정할 수 없습니다.")
    others = [reader for reader in readers if reader.get("reader_id") != current_reader_id]
    return (others or readers)[0]


def _live(api: str, token: str) -> dict:
    response = requests.get(
        f"{api}/rtls/live", params={"hide_simulated": "true"}, headers=auth(token), timeout=HTTP_TIMEOUT_SEC
    )
    response.raise_for_status()
    return response.json()


def _find_equipment(live: dict, name: str) -> dict:
    for item in live.get("items", []):
        if item.get("equipment_name") == name:
            return item
    raise SystemExit(f"실시간 목록에서 {name}을(를) 찾지 못했습니다.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="측위 보고 위조 차단 실연(운영 /ingest)")
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--equipment", default="수액펌프-001", help="실물 비콘을 단 장비")
    args = parser.parse_args(argv)

    title("측위 보고 위조 차단", f"{args.api}/ingest")
    token = demo_login(args.api, "staff")
    live = _live(args.api, token)
    tag = _find_equipment(live, args.equipment)
    real_readers = [reader for reader in live.get("readers", []) if reader.get("is_real_hardware")]
    target = pick_target_reader(real_readers, tag.get("reader_id"))
    line(f"현재 위치  {args.equipment} · {tag.get('location') or '미확인'}")
    line(f"공격 목표  {target.get('location')}({target['reader_id']}) 위치 거짓 보고")

    reports = build_forged_reports(target["reader_id"], tag["tag_id"], int(time.time()))
    blocked = 0
    for number, report in enumerate(reports, start=1):
        section(number, report.title)
        line(dim(report.explain))
        response = requests.post(
            f"{args.api}/ingest", data=report.body, headers=report.headers, timeout=HTTP_TIMEOUT_SEC
        )
        if response.status_code >= 400:
            blocked += 1
            line(good(f"→ {response.status_code} {detail_of(response)} · 차단"))
        else:
            line(bad(f"→ {response.status_code} 수락됨 · 차단 실패"))

    after = _find_equipment(_live(args.api, token), args.equipment)
    moved = after.get("reader_id") != tag.get("reader_id")
    print()
    line(f"결과  위조 보고 {len(reports)}건 중 {blocked}건 차단")
    line(f"현재 위치  {args.equipment} · {after.get('location') or '미확인'} ({'변경됨' if moved else '변화 없음'})")
    return 0 if blocked == len(reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
