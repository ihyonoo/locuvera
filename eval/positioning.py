"""측위 평가 — 관측 트레이스를 판정 규칙에 다시 흘려 파라미터별 결과를 얻는다.

백엔드가 실제로 쓰는 backend.location_decision.decide_transition을 그대로 호출한다.
규칙을 복제하면 평가 대상이 구현이 아니라 복제본이 되므로, 이 모듈은 /ingest가
관측을 쌓는 방식만 흉내 내고 판정 자체는 손대지 않는다.
"""

from collections.abc import Iterable
from pathlib import Path
from typing import NamedTuple

from backend.location_decision import DEFAULT_PARAMS, DecisionParams, decide_transition, new_tag_state


class Observation(NamedTuple):
    """리더가 한 번의 전송에 실어 보낸 태그 하나의 관측.

    seq는 페이로드 순번이다. 같은 초에 여러 리더가 보낸 관측의 처리 순서까지
    재현해야 판정 결과가 서버와 일치한다.
    """

    seq: int
    recv_ts: int
    reader_id: str
    tag_id: str
    rssi: int
    count: int
    last_seen: int


def replay_transitions(
    observations: Iterable[Observation],
    params: DecisionParams = DEFAULT_PARAMS,
) -> list[tuple[str, str, int]]:
    """트레이스를 순서대로 판정해 확정된 전환만 (tag_id, reader_id, decided_at)로 돌려준다."""
    tag_obs: dict[str, dict[str, dict]] = {}
    tag_state: dict[str, dict] = {}
    transitions: list[tuple[str, str, int]] = []

    for observation in sorted(observations, key=lambda row: row.seq):
        now = observation.recv_ts
        tag_id = observation.tag_id

        tag_obs.setdefault(tag_id, {})
        tag_obs[tag_id][observation.reader_id] = {
            "rssi": observation.rssi,
            "count": observation.count,
            "last_seen": observation.last_seen,
            "recv_ts": now,
        }

        state = tag_state.setdefault(tag_id, new_tag_state())
        transition = decide_transition(tag_obs[tag_id], state, now, params)
        if transition is not None:
            reader_id, _rssi, decided_at = transition
            transitions.append((tag_id, reader_id, decided_at))

    return transitions


def _parse_args(argv: list[str] | None = None):
    import argparse

    parser = argparse.ArgumentParser(prog="python -m eval.positioning", description="측위 판정 평가")
    sub = parser.add_subparsers(dest="command", required=True)

    collect = sub.add_parser("collect", help="가상 병원을 돌려 관측·참값 트레이스를 남긴다")
    collect.add_argument("--hours", type=float, default=4.0)
    collect.add_argument("--seed", type=int, default=20260920)
    collect.add_argument("--start", default="2026-09-21T08:00", help="시뮬레이션 속 시작 시각(KST)")
    collect.add_argument("--out", type=Path, default=Path("eval/runs/latest/trace.sqlite"))

    sweep = sub.add_parser("sweep", help="트레이스에 파라미터 격자를 적용해 결과 CSV를 쓴다")
    sweep.add_argument("--trace", type=Path, default=Path("eval/runs/latest/trace.sqlite"))
    sweep.add_argument("--out", type=Path, default=Path("eval/runs/latest/results.csv"))
    sweep.add_argument("--workers", type=int, default=None)

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    import datetime as dt

    args = _parse_args(argv)

    if args.command == "collect":
        from eval.collect import collect
        from simulation import demand

        start = dt.datetime.fromisoformat(args.start).replace(tzinfo=demand.KST)
        summary = collect(args.out, hours=args.hours, seed=args.seed, start=start)
        print(f"트레이스: {args.out}")
        print(f"  관측 {summary['observations']:,}행 · 참값 {summary['truth']:,}행")
        print(f"  태그 {summary['tags']}개 · 리더 {summary['readers']}대 · 시드 {summary['seed']}")
        return

    from eval.sweep import run

    rows = run(args.trace, args.out, workers=args.workers)
    print(f"결과: {args.out} ({len(rows)}조합)")

    current = next((r for r in rows if (r.hyst_db, r.dwell_sec, r.stale_sec) == (8, 2, 5)), None)
    if current is not None:
        print(f"  현행 8dB/2초/5초 — 정지 정확도 {current.rest_accuracy:.4f}, 전환 지연 p50 {current.delay_p50}")

    best = max((r for r in rows if r.rest_accuracy is not None), key=lambda r: r.rest_accuracy, default=None)
    if best is not None:
        print(
            f"  정지 정확도 최고 {best.hyst_db}dB/{best.dwell_sec}초/{best.stale_sec}초 — "
            f"{best.rest_accuracy:.4f}, 전환 지연 p50 {best.delay_p50}"
        )


if __name__ == "__main__":
    main()
