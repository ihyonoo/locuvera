"""HYST_DB(히스테리시스)/DWELL_SEC(체류)/STALE_SEC(신선도)로 위치 판정 플래핑을 막는
/ingest 로직 통합 테스트.

backend/settings.py 기준 HYST_DB=8, DWELL_SEC=2, STALE_SEC=5.
"""

from backend.server import tag_state


def _post_ingest(client, monkeypatch, *, now, reader_id, tag_id, rssi):
    monkeypatch.setattr("backend.server.time.time", lambda: float(now))
    response = client.post(
        "/ingest",
        json={
            "reader_id": reader_id,
            "ts": now,
            "observations": [{"tag_id": tag_id, "rssi": rssi, "count": 1, "last_seen": now}],
        },
    )
    assert response.status_code == 200
    return response


class TestIngestHysteresisAndDwell:
    def test_first_observation_sets_current_reader_immediately(self, client, seed_tag, monkeypatch):
        tag_id = seed_tag()

        _post_ingest(client, monkeypatch, now=0, reader_id="M503", tag_id=tag_id, rssi=-60)

        assert tag_state[tag_id]["current_reader"] == "M503"

    def test_small_rssi_difference_does_not_switch_reader(self, client, seed_tag, monkeypatch):
        tag_id = seed_tag()
        _post_ingest(client, monkeypatch, now=0, reader_id="M503", tag_id=tag_id, rssi=-60)

        # M504가 5dB 더 강하지만 HYST_DB(8dB)를 넘지 못해 전환되면 안 된다.
        _post_ingest(client, monkeypatch, now=1, reader_id="M504", tag_id=tag_id, rssi=-55)

        assert tag_state[tag_id]["current_reader"] == "M503"
        assert tag_state[tag_id]["candidate_reader"] is None

    def test_switches_only_after_hysteresis_and_dwell_both_satisfied(self, client, seed_tag, monkeypatch):
        tag_id = seed_tag()
        _post_ingest(client, monkeypatch, now=0, reader_id="M503", tag_id=tag_id, rssi=-60)

        # HYST_DB(8dB)는 넘지만(10dB 차이) DWELL_SEC(2초)가 아직 지나지 않아 후보로만 등록된다.
        _post_ingest(client, monkeypatch, now=2, reader_id="M504", tag_id=tag_id, rssi=-50)
        assert tag_state[tag_id]["current_reader"] == "M503"
        assert tag_state[tag_id]["candidate_reader"] == "M504"

        # DWELL_SEC(2초) 이상 같은 후보가 유지되면 그제서야 전환된다.
        _post_ingest(client, monkeypatch, now=4, reader_id="M504", tag_id=tag_id, rssi=-50)
        assert tag_state[tag_id]["current_reader"] == "M504"
        assert tag_state[tag_id]["candidate_reader"] is None

    def test_candidate_resets_if_signal_drops_back_below_hysteresis(self, client, seed_tag, monkeypatch):
        tag_id = seed_tag()
        _post_ingest(client, monkeypatch, now=0, reader_id="M503", tag_id=tag_id, rssi=-60)
        _post_ingest(client, monkeypatch, now=1, reader_id="M504", tag_id=tag_id, rssi=-50)
        assert tag_state[tag_id]["candidate_reader"] == "M504"

        # M504 신호가 다시 약해져 히스테리시스를 못 넘기면 후보에서 빠져야 한다.
        _post_ingest(client, monkeypatch, now=2, reader_id="M504", tag_id=tag_id, rssi=-56)

        assert tag_state[tag_id]["current_reader"] == "M503"
        assert tag_state[tag_id]["candidate_reader"] is None


class TestIngestStaleObservations:
    """STALE_SEC(5초)가 만료된 관측을 판정에서 어떻게 빼는지 못박는다."""

    def test_expired_observation_keeps_competing_until_the_freshness_limit(self, client, seed_tag, monkeypatch):
        tag_id = seed_tag()
        _post_ingest(client, monkeypatch, now=0, reader_id="M503", tag_id=tag_id, rssi=-50)

        # M503의 관측은 5초까지 살아 있으므로, 더 약한 M504는 아직 후보조차 되지 못한다.
        _post_ingest(client, monkeypatch, now=5, reader_id="M504", tag_id=tag_id, rssi=-70)

        assert tag_state[tag_id]["current_reader"] == "M503"
        assert tag_state[tag_id]["candidate_reader"] is None

    def test_expired_current_reader_loses_the_hysteresis_advantage(self, client, seed_tag, monkeypatch):
        tag_id = seed_tag()
        _post_ingest(client, monkeypatch, now=0, reader_id="M503", tag_id=tag_id, rssi=-50)

        # 6초가 지나 M503의 관측이 만료되면 -999로 취급되므로, 훨씬 약한 M504도 히스테리시스를
        # 넘어 후보가 된다. 갱신이 끊긴 리더가 위치를 계속 붙잡지 못하게 하는 장치다.
        _post_ingest(client, monkeypatch, now=6, reader_id="M504", tag_id=tag_id, rssi=-70)
        assert tag_state[tag_id]["current_reader"] == "M503"
        assert tag_state[tag_id]["candidate_reader"] == "M504"

        _post_ingest(client, monkeypatch, now=8, reader_id="M504", tag_id=tag_id, rssi=-70)
        assert tag_state[tag_id]["current_reader"] == "M504"


class TestIngestDecisionSequence:
    """규칙의 모든 분기를 한 시나리오로 통과시키고, 확정된 전환만 이력에 남는지 확인한다."""

    def test_only_confirmed_transitions_are_recorded(self, client, db_conn, seed_tag, monkeypatch):
        tag_id = seed_tag()
        steps = [
            (0, "M503", -60),  # 최초 관측 → 즉시 확정
            (1, "M503", -60),  # 같은 리더 → 유지
            (2, "M504", -55),  # 5dB 차 → 히스테리시스 미달
            (3, "M504", -50),  # 10dB 차 → 후보 등록
            (4, "M504", -50),  # 체류 1초 → 아직
            (5, "M504", -50),  # 체류 2초 → 전환
            (6, "M504", -50),  # 같은 리더 → 유지
            (10, "M503", -70),  # M504 관측이 아직 신선해 더 강하다 → 유지
            (11, "M503", -70),  # 경계(5초) → 여전히 신선
            (12, "M503", -70),  # M504 만료 → -999와 비교 → 후보 등록
            (13, "M503", -70),  # 체류 1초 → 아직
            (14, "M503", -70),  # 체류 2초 → 전환
        ]
        for now, reader_id, rssi in steps:
            _post_ingest(client, monkeypatch, now=now, reader_id=reader_id, tag_id=tag_id, rssi=rssi)

        with db_conn.cursor() as cur:
            cur.execute(
                """
                SELECT reader_id, EXTRACT(EPOCH FROM decided_at)::BIGINT
                FROM tag_state_history WHERE tag_id = %s ORDER BY history_id
                """,
                (tag_id,),
            )
            assert cur.fetchall() == [("M503", 0), ("M504", 5), ("M503", 14)]
