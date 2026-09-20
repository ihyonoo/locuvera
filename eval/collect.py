"""트레이스 수집 — 가상 병원을 서버 없이 돌려 관측과 참값을 남긴다.

simulator.py가 네 개의 비동기 루프로 하는 일을 하나의 동기 루프로 바꾼 것이다.
시각을 인자로 받는 World를 그대로 쓰되 벽시계를 기다리지 않으므로, 하루치도
실제로는 몇 분 만에 끝난다. HTTP도 DB도 쓰지 않는다.
"""

import datetime as dt
import random
import subprocess
from pathlib import Path

from eval import trace
from eval.metrics import TruthSample
from eval.positioning import Observation
from simulation import demand, radio, world
from simulation.reader import SEND_EVERY_SEC, WINDOW_SEC

FLUSH_EVERY = 200_000


def _git_commit() -> str | None:
    try:
        result = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def collect(
    out_path: Path,
    *,
    hours: float,
    seed: int,
    start: dt.datetime,
) -> dict:
    """가상 병원을 hours만큼 돌려 트레이스를 쓰고, 요약을 돌려준다."""
    horizon = hours * 3600.0
    instance = world.World(rng=random.Random(seed), now=0.0)
    connection = trace.open_trace(out_path, create=True)

    observations: list[Observation] = []
    truths: list[TruthSample] = []
    seq = 0
    now = 0.0
    next_send = SEND_EVERY_SEC
    next_behavior = world.BEHAVIOR_TICK_SEC

    while now < horizon:
        now += world.PHYSICS_TICK_SEC
        instance.tick_physics(now, world.PHYSICS_TICK_SEC)

        if now >= next_behavior:
            moment = start + dt.timedelta(seconds=now)
            for command in instance.tick_behavior(moment, now):
                instance.confirm_checkout(command.tag_id, now)
            for command in instance.due_returns(moment, now):
                instance.confirm_return(command.tag_id, now)
            next_behavior += world.BEHAVIOR_TICK_SEC

        if now < next_send:
            continue
        next_send += SEND_EVERY_SEC

        for payload in instance.collect_payloads(now):
            if not payload["observations"]:
                continue
            seq += 1
            for observation in payload["observations"]:
                observations.append(
                    Observation(
                        seq=seq,
                        recv_ts=int(now),
                        reader_id=payload["reader_id"],
                        tag_id=observation["tag_id"],
                        rssi=observation["rssi"],
                        count=observation["count"],
                        last_seen=observation["last_seen"],
                    )
                )

        for tag_id in instance.tags:
            placement = instance.placement_of(tag_id)
            truths.append(
                TruthSample(
                    ts=int(now),
                    tag_id=tag_id,
                    zone_a=placement.zone_a,
                    zone_b=placement.zone_b,
                    progress=placement.progress,
                )
            )

        if len(observations) >= FLUSH_EVERY:
            trace.write_observations(connection, observations)
            trace.write_truth(connection, truths)
            observations.clear()
            truths.clear()

    trace.write_observations(connection, observations)
    trace.write_truth(connection, truths)

    meta = {
        "seed": seed,
        "hours": hours,
        "start_kst": start.isoformat(),
        "git_commit": _git_commit(),
        "tags": len(instance.tags),
        "readers": len(instance.windows),
        "physics_tick_sec": world.PHYSICS_TICK_SEC,
        "window_sec": WINDOW_SEC,
        "send_every_sec": SEND_EVERY_SEC,
        "radio": {
            "rssi_at_1m": radio.RSSI_AT_1M,
            "path_loss_exponent": radio.PATH_LOSS_EXPONENT,
            "wall_attenuation_db": radio.WALL_ATTENUATION_DB,
            "rx_sensitivity_dbm": radio.RX_SENSITIVITY_DBM,
            "fast_noise_sigma_db": radio.FAST_NOISE_SIGMA_DB,
            "slow_noise_sigma_db": radio.SLOW_NOISE_SIGMA_DB,
            "tag_tx_sigma_db": radio.TAG_TX_SIGMA_DB,
        },
        "demand_band_day": demand.DAY_BAND,
        "demand_band_night": demand.NIGHT_BAND,
    }
    trace.write_meta(connection, meta)
    trace.finalize(connection)

    counts = {
        "observations": connection.execute("SELECT count(*) FROM observations").fetchone()[0],
        "truth": connection.execute("SELECT count(*) FROM truth").fetchone()[0],
    }
    connection.close()
    return {**meta, **counts}
