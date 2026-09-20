"""기록한 관측을 다시 판정하는 재생기가 실제 /ingest와 같은 결론을 내는지 확인한다.

측위 평가는 관측을 한 번 수집해 두고 파라미터만 바꿔가며 재생한다. 재생이 서버와
어긋나면 조합별 결과 전체가 근거를 잃으므로, 기본 파라미터에서 두 경로의 판정
시퀀스가 완전히 일치하는지를 못박아 둔다.
"""

import datetime as dt
import random

import pytest

from eval.positioning import Observation, replay_transitions
from simulation import demand, world
from simulation.generate_seed import render_seed_sql

WEEKDAY_10AM = dt.datetime(2026, 8, 12, 10, 0, tzinfo=demand.KST)


@pytest.fixture
def seeded_hospital(db_conn):
    with db_conn.cursor() as cur:
        cur.execute(render_seed_sql())
    db_conn.commit()
    return db_conn


def _force_checkout(instance, now: float) -> str:
    """장비 하나를 실제로 움직이게 만든다 — 정지 상태만으로는 전환 분기를 거의 타지 않는다."""
    for _ in range(60):
        commands = instance.tick_behavior(WEEKDAY_10AM, now)
        if commands:
            instance.confirm_checkout(commands[0].tag_id, now)
            return commands[0].tag_id
        now += world.BEHAVIOR_TICK_SEC
    raise AssertionError("시뮬레이터가 대여를 한 건도 내지 않았다")


def _pump(instance, client, monkeypatch, trace, *, start, seconds, seq, only_tag=None):
    """물리 틱을 돌리면서 1초마다 /ingest로 보내고, 같은 페이로드를 트레이스에 남긴다."""
    now = start
    for step in range(int(seconds / world.PHYSICS_TICK_SEC)):
        now += world.PHYSICS_TICK_SEC
        instance.tick_physics(now, world.PHYSICS_TICK_SEC)
        if step % 5 != 4:
            continue

        monkeypatch.setattr("backend.server.time.time", lambda now=now: now)
        for payload in instance.collect_payloads(now):
            observations = payload["observations"]
            if only_tag is not None:
                observations = [o for o in observations if o["tag_id"] == only_tag]
            if not observations:
                continue

            seq += 1
            for observation in observations:
                trace.append(
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
            assert client.post("/ingest", json={**payload, "observations": observations}).status_code == 200
    return now, seq


def _decisions_in_db(db_conn) -> list[tuple[str, str, int]]:
    with db_conn.cursor() as cur:
        cur.execute(
            """
            SELECT tag_id, reader_id, EXTRACT(EPOCH FROM decided_at)::BIGINT
            FROM tag_state_history ORDER BY history_id
            """
        )
        return cur.fetchall()


class TestReplayEquivalence:
    def test_replay_reproduces_every_decision_the_backend_made(self, client, seeded_hospital, monkeypatch):
        instance = world.World(rng=random.Random(11), now=1000.0)
        trace: list[Observation] = []

        # 전 장비의 최초 판정을 만든 뒤, 한 대를 움직여 전환 분기까지 태운다.
        now, seq = _pump(instance, client, monkeypatch, trace, start=1000.0, seconds=8.0, seq=0)
        moved = _force_checkout(instance, now)
        now, seq = _pump(instance, client, monkeypatch, trace, start=now, seconds=120.0, seq=seq, only_tag=moved)

        expected = _decisions_in_db(seeded_hospital)
        assert [row for row in expected if row[0] == moved][1:], "대여한 장비가 구역을 옮기지 않았다"

        assert replay_transitions(trace) == expected
