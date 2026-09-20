"""판정 규칙의 신선도 처리 — 계단식 만료와 시간 감쇠를 비교 가능한 형태로 못박는다.

기본값(decay_db_per_sec=0)은 계단식이다. 감쇠를 켜면 만료 전까지도 낡은 관측이
경과 시간만큼 약해진 값으로 경쟁하므로, 4초 된 값이 방금 들어온 값과 같은 무게를
갖지 않는다. 어느 쪽이 나은지는 측위 평가에서 가린다.
"""

from backend.location_decision import DecisionParams, decide_transition, new_tag_state, pick_best_reader


def observations(**readers: tuple[int, int]) -> dict[str, dict]:
    """reader_id=(rssi, recv_ts) 형태로 관측표를 만든다."""
    return {
        reader_id: {"rssi": rssi, "count": 1, "last_seen": recv_ts, "recv_ts": recv_ts}
        for reader_id, (rssi, recv_ts) in readers.items()
    }


class TestFreshnessIsAStepByDefault:
    def test_an_unexpired_observation_competes_at_full_strength(self):
        table = observations(A=(-50, 0), B=(-70, 4))

        assert pick_best_reader(table, now=4, stale_sec=5)[0] == "A"

    def test_an_expired_observation_drops_out_entirely(self):
        table = observations(A=(-50, 0), B=(-70, 6))

        assert pick_best_reader(table, now=6, stale_sec=5)[0] == "B"


class TestDecay:
    def test_decay_weakens_an_aging_observation(self):
        table = observations(A=(-50, 0), B=(-70, 4))

        # 4초 동안 초당 6dB씩 깎이면 A는 -74가 되어 방금 들어온 B(-70)에 진다.
        assert pick_best_reader(table, now=4, stale_sec=5, decay_db_per_sec=6.0)[0] == "B"

    def test_decay_still_respects_the_hard_expiry(self):
        table = observations(A=(-50, 0), B=(-70, 6))

        assert pick_best_reader(table, now=6, stale_sec=5, decay_db_per_sec=1.0)[0] == "B"

    def test_zero_decay_leaves_the_ranking_untouched(self):
        table = observations(A=(-50, 0), B=(-70, 4))

        assert pick_best_reader(table, now=4, stale_sec=5, decay_db_per_sec=0.0)[0] == "A"

    def test_decay_applies_to_the_current_reader_too(self):
        table = observations(A=(-50, 0))
        state = new_tag_state()
        decide_transition(table, state, now=0, params=DecisionParams())
        assert state["current_reader"] == "A"

        # 감쇠가 없으면 -50인 A가 -60인 B를 이겨 전환이 일어나지 않는다.
        table = observations(A=(-50, 0), B=(-60, 3))
        steady = dict(state)
        decide_transition(table, steady, now=3, params=DecisionParams())
        assert steady["candidate_reader"] is None

        # 초당 8dB 감쇠면 A는 -74까지 내려가, B(-60)가 히스테리시스 8dB를 넘어 후보가 된다.
        decaying = dict(state)
        decide_transition(table, decaying, now=3, params=DecisionParams(decay_db_per_sec=8.0))
        assert decaying["candidate_reader"] == "B"
