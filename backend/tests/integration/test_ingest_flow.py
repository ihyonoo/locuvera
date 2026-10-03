"""HYST_DB(히스테리시스)/DWELL_SEC(체류)/STALE_SEC(신선도)로 위치 판정 플래핑을 막는
/ingest 로직 통합 테스트.

backend/settings.py 기준 HYST_DB=10, DWELL_SEC=3, STALE_SEC=5.
"""

import pytest
from fastapi.testclient import TestClient

from backend.server import app, tag_obs, tag_state
from backend.tests.conftest import post_signed_ingest


@pytest.fixture(autouse=True)
def _registered_readers(seed_reader):
    seed_reader("M503")
    seed_reader("M504")


def test_history_failure_does_not_publish_location_or_memory_state(seed_tag, monkeypatch):
    tag_id = seed_tag()
    monkeypatch.setattr(
        "backend.server.insert_location_history",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )
    client = TestClient(app, raise_server_exceptions=False)

    response = post_signed_ingest(
        client,
        {
            "reader_id": "M503",
            "ts": 100,
            "observations": [{"tag_id": tag_id, "rssi": -60, "count": 1, "last_seen": 100}],
        },
    )

    assert response.status_code == 500
    assert tag_id not in tag_obs
    assert tag_id not in tag_state


def _post_ingest(client, monkeypatch, *, now, reader_id, tag_id, rssi):
    monkeypatch.setattr("backend.server.time.time", lambda: float(now))
    response = post_signed_ingest(
        client,
        {
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

        # M504가 5dB 더 강하지만 HYST_DB(10dB)를 넘지 못해 전환되면 안 된다.
        _post_ingest(client, monkeypatch, now=1, reader_id="M504", tag_id=tag_id, rssi=-55)

        assert tag_state[tag_id]["current_reader"] == "M503"
        assert tag_state[tag_id]["candidate_reader"] is None

    def test_switches_only_after_hysteresis_and_dwell_both_satisfied(self, client, seed_tag, monkeypatch):
        tag_id = seed_tag()
        _post_ingest(client, monkeypatch, now=0, reader_id="M503", tag_id=tag_id, rssi=-60)

        # HYST_DB(10dB)는 넘지만(12dB 차이) DWELL_SEC(3초)가 아직 지나지 않아 후보로만 등록된다.
        _post_ingest(client, monkeypatch, now=2, reader_id="M504", tag_id=tag_id, rssi=-48)
        assert tag_state[tag_id]["current_reader"] == "M503"
        assert tag_state[tag_id]["candidate_reader"] == "M504"

        # DWELL_SEC(3초) 이상 같은 후보가 유지되면 그제서야 전환된다.
        _post_ingest(client, monkeypatch, now=5, reader_id="M504", tag_id=tag_id, rssi=-48)
        assert tag_state[tag_id]["current_reader"] == "M504"
        assert tag_state[tag_id]["candidate_reader"] is None

    def test_candidate_resets_if_signal_drops_back_below_hysteresis(self, client, seed_tag, monkeypatch):
        tag_id = seed_tag()
        _post_ingest(client, monkeypatch, now=0, reader_id="M503", tag_id=tag_id, rssi=-60)
        _post_ingest(client, monkeypatch, now=1, reader_id="M504", tag_id=tag_id, rssi=-48)
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

        _post_ingest(client, monkeypatch, now=9, reader_id="M504", tag_id=tag_id, rssi=-70)
        assert tag_state[tag_id]["current_reader"] == "M504"


class TestIngestDecisionSequence:
    """규칙의 모든 분기를 한 시나리오로 통과시키고, 확정된 전환만 이력에 남는지 확인한다."""

    def test_only_confirmed_transitions_are_recorded(self, client, db_conn, seed_tag, monkeypatch):
        tag_id = seed_tag()
        steps = [
            (0, "M503", -60),  # 최초 관측 → 즉시 확정
            (1, "M503", -60),  # 같은 리더 → 유지
            (2, "M504", -55),  # 5dB 차 → 히스테리시스 미달
            (3, "M504", -48),  # 12dB 차 → 후보 등록
            (4, "M504", -48),  # 체류 1초 → 아직
            (5, "M504", -48),  # 체류 2초 → 아직
            (6, "M504", -48),  # 체류 3초 → 전환
            (7, "M504", -48),  # 같은 리더 → 유지
            (11, "M503", -70),  # M504 관측이 아직 신선해 더 강하다 → 유지
            (12, "M503", -70),  # 경계(5초) → 여전히 신선
            (13, "M503", -70),  # M504 만료 → -999와 비교 → 후보 등록
            (14, "M503", -70),  # 체류 1초 → 아직
            (15, "M503", -70),  # 체류 2초 → 아직
            (16, "M503", -70),  # 체류 3초 → 전환
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
            assert cur.fetchall() == [("M503", 0), ("M504", 6), ("M503", 16)]
