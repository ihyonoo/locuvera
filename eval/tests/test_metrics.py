"""지표 정의를 합성 데이터로 못박는다 — 시뮬레이터 없이 손으로 만든 참값과 판정을 쓴다."""

from eval import metrics


def rest(ts: int, zone: str, tag_id: str = "T1") -> metrics.TruthSample:
    return metrics.TruthSample(ts=ts, tag_id=tag_id, zone_a=zone, zone_b=zone, progress=0.0)


def moving(ts: int, zone_a: str, zone_b: str, progress: float, tag_id: str = "T1") -> metrics.TruthSample:
    return metrics.TruthSample(ts=ts, tag_id=tag_id, zone_a=zone_a, zone_b=zone_b, progress=progress)


class TestRestAccuracy:
    def test_counts_only_resting_samples(self):
        truth = [rest(0, "A"), rest(1, "A"), moving(2, "A", "B", 0.5), rest(3, "B")]
        result = metrics.compute(truth, [("T1", "A", 0)])

        # 정지 표본 3개 중 0초·1초는 맞고 3초는 틀리다. 이동 표본은 분모에서 빠진다.
        assert result.rest_samples == 3
        assert result.move_samples == 1
        assert result.rest_accuracy == 2 / 3

    def test_samples_before_the_first_decision_count_as_wrong(self):
        truth = [rest(0, "A"), rest(1, "A")]
        result = metrics.compute(truth, [("T1", "A", 1)])

        assert result.rest_accuracy == 1 / 2


class TestTransitionDelay:
    def test_delay_is_measured_from_the_true_change_to_the_matching_decision(self):
        truth = [rest(0, "A"), moving(1, "A", "B", 0.5), rest(2, "B"), rest(3, "B")]
        result = metrics.compute(truth, [("T1", "A", 0), ("T1", "B", 5)])

        # 참값은 2초에 B가 되고 판정은 5초에 따라왔다.
        assert result.true_transitions == 1
        assert result.delay_p50 == 3
        assert result.missed_transitions == 0

    def test_a_decision_that_never_arrives_counts_as_missed(self):
        truth = [rest(0, "A"), rest(1, "B")]
        result = metrics.compute(truth, [("T1", "A", 0)])

        assert result.missed_transitions == 1
        assert result.delay_p50 is None


class TestFalseSwitch:
    def test_a_decision_while_the_true_zone_is_unchanged_is_a_false_switch(self):
        truth = [rest(ts, "A") for ts in range(0, 3600)]
        result = metrics.compute(truth, [("T1", "A", 0), ("T1", "B", 100), ("T1", "A", 200)])

        # 참값은 내내 A인데 판정이 세 번 일어났다 — 첫 판정을 뺀 둘이 오전환이다.
        assert result.judged_transitions == 3
        assert result.false_switch_per_hour == 2 / ((3599 * 1) / 3600)

    def test_following_a_real_move_is_not_a_false_switch(self):
        truth = [rest(0, "A"), rest(1, "A"), rest(2, "B"), rest(3, "B")]
        result = metrics.compute(truth, [("T1", "A", 0), ("T1", "B", 2)])

        assert result.false_switch_per_hour == 0


class TestPath:
    def test_recall_and_precision_compare_the_visited_zone_sets(self):
        truth = [rest(0, "A"), moving(1, "A", "B", 0.5), rest(2, "B"), moving(3, "B", "C", 0.5), rest(4, "C")]
        result = metrics.compute(truth, [("T1", "A", 0), ("T1", "C", 4)])

        # 참값은 A·B·C를 거쳤고 판정은 A·C만 남겼다. 판정한 둘은 모두 실제 경로 위에 있다.
        assert result.path_recall == 2 / 3
        assert result.path_precision == 1.0

    def test_a_zone_that_was_never_visited_lowers_precision(self):
        truth = [rest(0, "A"), rest(1, "A")]
        result = metrics.compute(truth, [("T1", "A", 0), ("T1", "Z", 1)])

        assert result.path_recall == 1.0
        assert result.path_precision == 1 / 2


class TestUnheard:
    def test_samples_no_reader_heard_are_counted_when_the_set_is_given(self):
        truth = [rest(0, "A"), rest(1, "A"), rest(2, "A"), rest(3, "A")]
        heard = {("T1", 0), ("T1", 1)}
        result = metrics.compute(truth, [("T1", "A", 0)], heard=heard)

        assert result.unheard_ratio == 2 / 4

    def test_the_ratio_is_absent_when_no_set_is_given(self):
        result = metrics.compute([rest(0, "A")], [("T1", "A", 0)])

        assert result.unheard_ratio is None


class TestMultipleTags:
    def test_metrics_aggregate_across_tags(self):
        truth = [rest(0, "A", "T1"), rest(1, "A", "T1"), rest(0, "B", "T2"), rest(1, "C", "T2")]
        result = metrics.compute(truth, [("T1", "A", 0), ("T2", "B", 0)])

        # T1은 둘 다 맞고, T2는 0초만 맞다.
        assert result.rest_samples == 4
        assert result.rest_accuracy == 3 / 4
