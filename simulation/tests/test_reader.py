from simulation import reader


class TestBuildPayload:
    def test_payload_shape_matches_the_backend_schema(self):
        window = reader.ReaderWindow("M203")
        window.add("EQ-0001", -71.2, at=100.0)
        payload = window.build_payload(now=100.5)

        assert set(payload) == {"reader_id", "ts", "observations"}
        assert payload["reader_id"] == "M203"
        assert isinstance(payload["ts"], int)
        observation = payload["observations"][0]
        assert set(observation) == {"tag_id", "rssi", "count", "last_seen"}
        assert isinstance(observation["rssi"], int)
        assert isinstance(observation["count"], int)
        assert isinstance(observation["last_seen"], int)

    def test_reports_the_median_rssi_of_the_window(self):
        window = reader.ReaderWindow("M203")
        for rssi in (-80.0, -70.0, -60.0):
            window.add("EQ-0001", rssi, at=100.0)
        assert window.build_payload(now=100.5)["observations"][0]["rssi"] == -70

    def test_counts_the_samples_in_the_window(self):
        window = reader.ReaderWindow("M203")
        for _ in range(10):
            window.add("EQ-0001", -70.0, at=100.0)
        assert window.build_payload(now=100.5)["observations"][0]["count"] == 10

    def test_drops_samples_older_than_the_window(self):
        window = reader.ReaderWindow("M203")
        window.add("EQ-0001", -90.0, at=100.0)
        window.add("EQ-0001", -60.0, at=103.0)
        observation = window.build_payload(now=103.5)["observations"][0]
        assert observation["count"] == 1
        assert observation["rssi"] == -60

    def test_forgets_a_tag_once_all_its_samples_expire(self):
        window = reader.ReaderWindow("M203")
        window.add("EQ-0001", -70.0, at=100.0)
        assert window.build_payload(now=110.0)["observations"] == []

    def test_last_seen_is_the_newest_sample_time(self):
        window = reader.ReaderWindow("M203")
        window.add("EQ-0001", -70.0, at=100.0)
        window.add("EQ-0001", -70.0, at=100.8)
        assert window.build_payload(now=101.0)["observations"][0]["last_seen"] == 100

    def test_groups_multiple_tags_into_one_payload(self):
        window = reader.ReaderWindow("M203")
        window.add("EQ-0001", -70.0, at=100.0)
        window.add("EQ-0002", -80.0, at=100.0)
        observations = window.build_payload(now=100.5)["observations"]
        assert {o["tag_id"] for o in observations} == {"EQ-0001", "EQ-0002"}

    def test_emits_a_heartbeat_payload_when_nothing_is_heard(self):
        # 실물 리더는 관측 0건이면 POST를 건너뛰지만, 그러면 아무 장비도 없는 구역의
        # 리더가 영영 오프라인으로 뜬다. 백엔드는 관측 루프보다 먼저 리더를 upsert한다.
        payload = reader.ReaderWindow("M212").build_payload(now=100.0)
        assert payload["reader_id"] == "M212"
        assert payload["observations"] == []

    def test_building_a_payload_does_not_consume_the_window(self):
        window = reader.ReaderWindow("M203")
        window.add("EQ-0001", -70.0, at=100.0)
        assert window.build_payload(now=100.5)["observations"][0]["count"] == 1
        assert window.build_payload(now=100.6)["observations"][0]["count"] == 1


class TestConfigurableAggregation:
    """평가에서 같은 원시 표본을 다른 설정으로 다시 집계할 수 있어야 한다."""

    def _window(self, **kwargs):
        window = reader.ReaderWindow("M203", **kwargs)
        for at, rssi in ((100.0, -90.0), (100.4, -70.0), (100.8, -68.0)):
            window.add("EQ-0001", rssi, at=at)
        return window

    def test_default_is_the_real_reader_spec(self):
        window = self._window()
        assert window.window_sec == reader.WINDOW_SEC
        assert window.build_payload(now=101.0)["observations"][0]["rssi"] == -70

    def test_aggregate_can_be_swapped(self):
        assert self._window(aggregate="max").build_payload(now=101.0)["observations"][0]["rssi"] == -68
        assert self._window(aggregate="min").build_payload(now=101.0)["observations"][0]["rssi"] == -90
        assert self._window(aggregate="mean").build_payload(now=101.0)["observations"][0]["rssi"] == -76

    def test_a_shorter_window_drops_the_older_samples(self):
        observations = self._window(window_sec=0.5).build_payload(now=101.0)["observations"]
        # 100.5초 이전 표본이 빠져 -68 하나만 남는다.
        assert observations[0]["count"] == 1
        assert observations[0]["rssi"] == -68
