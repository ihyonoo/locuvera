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


def replay_dataset(dataset, params: DecisionParams = DEFAULT_PARAMS) -> list[tuple[int, int, int]]:
    """압축 배열 위에서 같은 규칙을 돌린다. (tag_idx, zone_idx, decided_at)를 돌려준다.

    관측마다 딕셔너리를 새로 만들지 않고 리더별 슬롯의 값만 갈아끼운다. 판정 규칙이
    읽는 항목은 신호 세기와 수신 시각 둘뿐이라, 슬롯을 재사용해도 결과가 달라지지 않는다.
    """
    obs_ts = dataset.obs_ts
    obs_reader = dataset.obs_reader
    obs_tag = dataset.obs_tag
    obs_rssi = dataset.obs_rssi

    tables: list[dict[int, dict]] = [{} for _ in range(len(dataset.tags))]
    states: list[dict] = [new_tag_state() for _ in range(len(dataset.tags))]
    transitions: list[tuple[int, int, int]] = []

    for position in range(len(obs_ts)):
        now = obs_ts[position]
        tag = obs_tag[position]
        table = tables[tag]

        slot = table.get(obs_reader[position])
        if slot is None:
            table[obs_reader[position]] = {"rssi": obs_rssi[position], "recv_ts": now}
        else:
            slot["rssi"] = obs_rssi[position]
            slot["recv_ts"] = now

        transition = decide_transition(table, states[tag], now, params)
        if transition is not None:
            transitions.append((tag, transition[0], now))

    return transitions


def _parse_args(argv: list[str] | None = None):
    import argparse

    parser = argparse.ArgumentParser(prog="python -m eval.positioning", description="측위 판정 평가")
    sub = parser.add_subparsers(dest="command", required=True)

    collect = sub.add_parser("collect", help="가상 병원을 돌려 관측·참값·원시 트레이스를 남긴다")
    collect.add_argument("--hours", type=float, default=24.0)
    collect.add_argument("--raw-hours", type=float, default=24.0, help="집계 이전 표본을 남길 앞 구간")
    collect.add_argument("--seed", type=int, default=20260920)
    collect.add_argument("--start", default="2026-09-21T00:00", help="시뮬레이션 속 시작 시각(KST)")
    collect.add_argument("--out", type=Path, default=Path("eval/runs/latest/trace.sqlite"))

    sweep = sub.add_parser("sweep", help="집계 격자와 판정 격자를 완전 교차해 결과 CSV를 쓴다")
    sweep.add_argument("--trace", type=Path, default=Path("eval/runs/latest/trace.sqlite"))
    sweep.add_argument("--out", type=Path, default=Path("eval/runs/latest/results.csv"))
    sweep.add_argument("--workers", type=int, default=None)

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    import datetime as dt
    import time

    args = _parse_args(argv)

    if args.command == "collect":
        from eval.collect import collect
        from simulation import demand

        start = dt.datetime.fromisoformat(args.start).replace(tzinfo=demand.KST)
        summary = collect(args.out, hours=args.hours, raw_hours=args.raw_hours, seed=args.seed, start=start)
        print(f"트레이스: {args.out}")
        print(f"  관측 {summary['observations']:,}행 · 참값 {summary['truth']:,}행 · 원시 {summary['raw_samples']:,}행")
        print(f"  태그 {summary['tags']}개 · 리더 {summary['readers']}대 · 시드 {summary['seed']}")
        return

    from eval import sweep

    started = time.time()

    def progress(done: int, total: int, rows: int) -> None:
        elapsed = time.time() - started
        eta = elapsed / done * (total - done)
        print(
            f"  집계 {done:>2}/{total} · 누적 {rows:,}행 · 경과 {elapsed / 60:.0f}분 · 남음 {eta / 60:.0f}분",
            flush=True,
        )

    print(f"완전 교차 {len(sweep.aggregation_grid())} × {len(sweep.decision_grid())} 조합", flush=True)
    rows = sweep.run(args.trace, args.out, workers=args.workers, progress=progress)
    print(f"결과: {args.out} ({len(rows):,}행)")

    ranked = [r for r in rows if r.rest_accuracy is not None]
    if not ranked:
        return
    best = max(ranked, key=lambda r: r.rest_accuracy)
    print(f"  정지 정확도 최고 {_describe(best)}")
    fewest = min(ranked, key=lambda r: r.missed_transitions)
    print(f"  놓친 전환 최소 {_describe(fewest)}")


def _describe(row) -> str:
    return (
        f"{row.window_sec:g}초·{row.aggregate} / {row.hyst_db}dB·{row.dwell_sec:g}초·{row.stale_sec:g}초"
        f"·감쇠{row.decay_db_per_sec:g}"
        f" — 정확도 {row.rest_accuracy:.4f} · 놓침 {row.missed_transitions}"
    )


if __name__ == "__main__":
    main()
