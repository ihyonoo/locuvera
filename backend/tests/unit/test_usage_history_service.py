"""usage_history_service의 순수 로직 + subprocess 오케스트레이션 단위 테스트.

DB I/O가 필요한 fetch_usage_record_for_chain/persist_usage_chain_anchor_metadata는
integration/test_usage_history_service.py 에서 다룬다. 여기서는 그 둘을 monkeypatch로
치환해 진짜 DB/Node 프로세스가 절대 실행되지 않게 한다.
"""

import json
import subprocess

from backend import usage_history_service as svc


class TestIsBesuReady:
    def test_ready_when_deployment_and_node_modules_exist(self, tmp_path, monkeypatch):
        besu_dir = tmp_path / "besu"
        (besu_dir / "node_modules").mkdir(parents=True)
        deployment_path = besu_dir / "deployments" / "usage-registry.json"
        deployment_path.parent.mkdir(parents=True)
        deployment_path.write_text("{}")
        monkeypatch.setattr(svc, "BESU_DIR", besu_dir)
        monkeypatch.setattr(svc, "BESU_DEPLOYMENT_PATH", deployment_path)
        monkeypatch.setenv("BESU_SENDER_PRIVATE_KEY", "0x" + "12" * 32)
        monkeypatch.setenv("BESU_SENDER_ADDRESS", "0x" + "34" * 20)

        ready, reason = svc.is_besu_ready(require_signer=True)

        assert ready is True
        assert reason is None

    def test_not_ready_when_sender_key_is_missing(self, tmp_path, monkeypatch):
        besu_dir = tmp_path / "besu"
        (besu_dir / "node_modules").mkdir(parents=True)
        deployment_path = besu_dir / "deployments" / "usage-registry.json"
        deployment_path.parent.mkdir(parents=True)
        deployment_path.write_text("{}")
        monkeypatch.setattr(svc, "BESU_DIR", besu_dir)
        monkeypatch.setattr(svc, "BESU_DEPLOYMENT_PATH", deployment_path)
        monkeypatch.delenv("BESU_SENDER_PRIVATE_KEY", raising=False)
        monkeypatch.delenv("BESU_SENDER_ADDRESS", raising=False)

        ready, reason = svc.is_besu_ready(require_signer=True)

        assert ready is False
        assert "BESU_SENDER_PRIVATE_KEY" in reason

    def test_read_remains_ready_without_sender_key(self, tmp_path, monkeypatch):
        besu_dir = tmp_path / "besu"
        (besu_dir / "node_modules").mkdir(parents=True)
        deployment_path = besu_dir / "deployments" / "usage-registry.json"
        deployment_path.parent.mkdir(parents=True)
        deployment_path.write_text("{}")
        monkeypatch.setattr(svc, "BESU_DIR", besu_dir)
        monkeypatch.setattr(svc, "BESU_DEPLOYMENT_PATH", deployment_path)
        monkeypatch.delenv("BESU_SENDER_PRIVATE_KEY", raising=False)
        monkeypatch.delenv("BESU_SENDER_ADDRESS", raising=False)

        assert svc.is_besu_ready() == (True, None)
        assert svc.is_besu_ready(require_signer=True)[0] is False

    def test_not_ready_when_deployment_file_missing(self, tmp_path, monkeypatch):
        besu_dir = tmp_path / "besu"
        (besu_dir / "node_modules").mkdir(parents=True)
        monkeypatch.setattr(svc, "BESU_DIR", besu_dir)
        monkeypatch.setattr(svc, "BESU_DEPLOYMENT_PATH", besu_dir / "deployments" / "usage-registry.json")

        ready, reason = svc.is_besu_ready()

        assert ready is False
        assert reason is not None

    def test_not_ready_when_node_modules_missing(self, tmp_path, monkeypatch):
        besu_dir = tmp_path / "besu"
        besu_dir.mkdir()
        deployment_path = besu_dir / "deployments" / "usage-registry.json"
        deployment_path.parent.mkdir(parents=True)
        deployment_path.write_text("{}")
        monkeypatch.setattr(svc, "BESU_DIR", besu_dir)
        monkeypatch.setattr(svc, "BESU_DEPLOYMENT_PATH", deployment_path)

        ready, reason = svc.is_besu_ready()

        assert ready is False
        assert reason is not None


class TestRunBesuScript:
    def test_invokes_node_with_expected_command_and_cwd(self, monkeypatch):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return subprocess.CompletedProcess(cmd, 0, stdout="ok\n", stderr="")

        monkeypatch.setattr(svc.subprocess, "run", fake_run)

        ok, stdout, stderr = svc.run_besu_script("read-usage-record.mjs", "123")

        assert ok is True
        assert stdout == "ok"
        assert stderr == ""
        assert captured["cmd"] == ["node", "scripts/read-usage-record.mjs", "123"]
        assert captured["kwargs"]["cwd"] == svc.BESU_DIR
        assert captured["kwargs"]["timeout"] == 30
        assert captured["kwargs"]["capture_output"] is True

    # 검증 payload를 인자로 넘기면 리눅스의 인자 길이 한도(MAX_ARG_STRLEN, 128KB)에 걸려
    # exec 자체가 E2BIG로 실패한다. 크기 제한이 없는 stdin으로 넘긴다.
    def test_sends_the_payload_through_stdin_instead_of_argv(self, monkeypatch):
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            captured["kwargs"] = kwargs
            return subprocess.CompletedProcess(cmd, 0, stdout="{}", stderr="")

        monkeypatch.setattr(svc.subprocess, "run", fake_run)

        payload = '{"items":[]}' + "x" * 200_000
        ok, _, _ = svc.run_besu_script("verify-usage-records.mjs", stdin_payload=payload)

        assert ok is True
        assert captured["cmd"] == ["node", "scripts/verify-usage-records.mjs"]
        assert captured["kwargs"]["input"] == payload

    def test_returns_false_on_nonzero_exit_code(self, monkeypatch):
        monkeypatch.setattr(
            svc.subprocess,
            "run",
            lambda cmd, **kwargs: subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom"),
        )

        ok, stdout, stderr = svc.run_besu_script("record-usage-record.mjs", "{}")

        assert ok is False
        assert stderr == "boom"

    def test_timeout_returns_ok_false_instead_of_raising(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            raise subprocess.TimeoutExpired(cmd, 30)

        monkeypatch.setattr(svc.subprocess, "run", fake_run)

        ok, stdout, stderr = svc.run_besu_script("read-usage-record.mjs", "123")

        assert ok is False
        assert stdout == ""
        assert "타임아웃" in stderr

    def test_missing_node_binary_returns_ok_false_instead_of_raising(self, monkeypatch):
        def fake_run(cmd, **kwargs):
            raise FileNotFoundError("node")

        monkeypatch.setattr(svc.subprocess, "run", fake_run)

        ok, stdout, stderr = svc.run_besu_script("read-usage-record.mjs", "123")

        assert ok is False
        assert stdout == ""


class TestReadUsageRecordFromChain:
    def test_not_configured_when_besu_not_ready(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (False, "이유"))
        calls = []
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: calls.append(a) or (True, "{}", ""))

        result = svc.read_usage_record_from_chain(1)

        assert result["status"] == "not_configured"
        assert result["exists"] is False
        assert calls == []

    def test_read_error_when_script_fails(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: (False, "", "node error"))

        result = svc.read_usage_record_from_chain(1)

        assert result["status"] == "read_error"
        assert result["detail"] == "node error"
        assert result["exists"] is False

    def test_read_error_on_invalid_json(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: (True, "not-json", ""))

        result = svc.read_usage_record_from_chain(1)

        assert result["status"] == "read_error"

    def test_ok_when_script_succeeds(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        payload = {"exists": True, "usageId": "1"}
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: (True, json.dumps(payload), ""))

        result = svc.read_usage_record_from_chain(1)

        assert result["status"] == "ok"
        assert result["exists"] is True
        assert result["record"] == payload


class TestUsageRecordMatchesChain:
    def test_matches_when_all_comparable_fields_equal(self):
        record = {
            "usageId": "1",
            "checkoutUserId": 1,
            "returnUserId": 2,
            "tagId": "t",
            "checkoutLocation": "a",
            "checkoutAt": 1,
            "returnLocation": "b",
            "returnedAt": 2,
            "movementPath": [{"location": "a", "at": 1}],
        }

        assert svc.usage_record_matches_chain(record, dict(record)) is True

    def test_mismatch_when_movement_path_differs(self):
        expected = {"usageId": "1", "movementPath": [{"location": "a", "at": 1}]}
        actual = {"usageId": "1", "movementPath": [{"location": "b", "at": 1}]}

        assert svc.usage_record_matches_chain(expected, actual) is False

    def test_mismatch_when_a_field_differs(self):
        expected = {"usageId": "1", "tagId": "t"}
        actual = {"usageId": "1", "tagId": "other"}

        assert svc.usage_record_matches_chain(expected, actual) is False


def _payload(**overrides):
    base = {
        "usageId": "1",
        "checkoutUserId": 1,
        "returnUserId": 2,
        "tagId": "TAG-1",
        "checkoutLocation": "수술실",
        "checkoutAt": 1_700_000_000,
        "returnLocation": "영상의학과",
        "returnedAt": 1_700_003_600,
    }
    base.update(overrides)
    return base


class TestAnchorUsageRecordToChain:
    def test_not_configured_when_besu_not_ready_and_no_io_happens(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (False, "이유"))
        fetch_calls = []
        run_calls = []
        monkeypatch.setattr(svc, "fetch_usage_record_for_chain", lambda uid: fetch_calls.append(uid))
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: run_calls.append(a) or (True, "{}", ""))

        result = svc.anchor_usage_record_to_chain(1)

        assert result == {"ok": False, "status": "not_configured", "detail": "이유"}
        assert fetch_calls == []
        assert run_calls == []

    def test_missing_usage_when_fetch_returns_none(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        monkeypatch.setattr(svc, "fetch_usage_record_for_chain", lambda uid: None)

        result = svc.anchor_usage_record_to_chain(1)

        assert result["ok"] is False
        assert result["status"] == "missing_usage"

    def test_already_anchored_when_onchain_record_matches(self, monkeypatch):
        payload = _payload()
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        monkeypatch.setattr(svc, "fetch_usage_record_for_chain", lambda uid: dict(payload))
        monkeypatch.setattr(
            svc,
            "read_usage_record_from_chain",
            lambda uid: {"status": "ok", "exists": True, "record": dict(payload)},
        )
        run_calls = []
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: run_calls.append(a) or (True, "{}", ""))

        result = svc.anchor_usage_record_to_chain(1)

        assert result["ok"] is True
        assert result["status"] == "already_anchored"
        assert run_calls == []  # 이미 온체인에 있으므로 기록 스크립트를 재호출하면 안 된다

    def test_mismatch_when_onchain_record_differs(self, monkeypatch):
        payload = _payload()
        onchain = _payload(tagId="다른-태그")
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        monkeypatch.setattr(svc, "fetch_usage_record_for_chain", lambda uid: dict(payload))
        monkeypatch.setattr(
            svc,
            "read_usage_record_from_chain",
            lambda uid: {"status": "ok", "exists": True, "record": onchain},
        )

        result = svc.anchor_usage_record_to_chain(1)

        assert result["ok"] is False
        assert result["status"] == "mismatch"
        assert result["record"] == onchain

    def test_anchors_successfully_when_not_yet_onchain(self, monkeypatch):
        payload = _payload()
        chain_result = {
            "txHash": "0xabc",
            "blockNumber": 5,
            "blockHash": "0xblock",
            "transactionIndex": 0,
            "recordedAt": 1_700_003_601,
        }
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        monkeypatch.setattr(svc, "fetch_usage_record_for_chain", lambda uid: dict(payload))
        monkeypatch.setattr(
            svc,
            "read_usage_record_from_chain",
            lambda uid: {"status": "not_configured", "exists": False, "detail": None},
        )
        recorded = []

        def fake_run(script_name, *args, stdin_payload=None, **kwargs):
            recorded.append((script_name, args, stdin_payload))
            return True, json.dumps(chain_result), ""

        monkeypatch.setattr(svc, "run_besu_script", fake_run)

        result = svc.anchor_usage_record_to_chain(1)

        assert result["ok"] is True
        assert result["status"] == "anchored"
        assert result["transaction_hash"] == "0xabc"
        assert result["block_number"] == 5
        assert recorded[0][0] == "record-usage-record.mjs"
        # 원문은 인자가 아니라 stdin으로 넘어간다.
        assert recorded[0][1] == ()
        assert json.loads(recorded[0][2]) == payload

    def test_record_error_when_script_fails(self, monkeypatch):
        payload = _payload()
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        monkeypatch.setattr(svc, "fetch_usage_record_for_chain", lambda uid: dict(payload))
        monkeypatch.setattr(
            svc,
            "read_usage_record_from_chain",
            lambda uid: {"status": "not_configured", "exists": False, "detail": None},
        )
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: (False, "", "revert"))

        result = svc.anchor_usage_record_to_chain(1)

        assert result["ok"] is False
        assert result["status"] == "record_error"
        assert result["detail"] == "revert"

    def test_record_error_on_invalid_json_response(self, monkeypatch):
        payload = _payload()
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        monkeypatch.setattr(svc, "fetch_usage_record_for_chain", lambda uid: dict(payload))
        monkeypatch.setattr(
            svc,
            "read_usage_record_from_chain",
            lambda uid: {"status": "not_configured", "exists": False, "detail": None},
        )
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: (True, "not-json", ""))

        result = svc.anchor_usage_record_to_chain(1)

        assert result["ok"] is False
        assert result["status"] == "record_error"


class TestVerifyUsageHistoryIntegrity:
    def test_not_ready_degrades_without_subprocess_call(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (False, "이유"))
        calls = []
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: calls.append(a) or (True, "{}", ""))
        rows = [(1, "returned") + (None,) * 23]

        results, summary = svc.verify_usage_history_integrity(rows)

        assert calls == []
        assert results[1]["verification_status"] == "not_configured"
        assert summary["failed_count"] == 1
        assert summary["not_eligible_count"] == 0

    def test_not_eligible_rows_skip_chain_check(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        calls = []

        def fake_run(*a, **k):
            calls.append(a)
            return True, json.dumps({"items": [], "summary": {}}), ""

        monkeypatch.setattr(svc, "run_besu_script", fake_run)
        rows = [(1, "checked_out") + (None,) * 23]

        results, _summary = svc.verify_usage_history_integrity(rows)

        assert results[1]["verification_status"] == "not_eligible"
        assert results[1]["eligible"] is False
        assert len(calls) == 1  # not_eligible 이어도 스크립트 자체는 한 번 호출된다

    # 한 번에 다 넘기면 100건에 6초라 601건이면 30초 타임아웃을 넘긴다. 배치로 쪼개 호출한다.
    def test_splits_large_batches_across_multiple_script_calls(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        batches = []

        def fake_run(script, *args, stdin_payload=None, **kwargs):
            items = json.loads(stdin_payload)["items"]
            batches.append(len(items))
            return (
                True,
                json.dumps(
                    {
                        "items": [{"usage_id": item["usageId"], "verification_status": "verified"} for item in items],
                        "summary": {"total_count": len(items), "verified_count": len(items)},
                    }
                ),
                "",
            )

        monkeypatch.setattr(svc, "run_besu_script", fake_run)
        rows = [(i, "returned") + (None,) * 23 for i in range(1, 251)]

        results, summary = svc.verify_usage_history_integrity(rows)

        assert batches == [svc.VERIFY_BATCH_SIZE, svc.VERIFY_BATCH_SIZE, 250 - 2 * svc.VERIFY_BATCH_SIZE]
        assert len(results) == 250
        assert all(r["verification_status"] == "verified" for r in results.values())
        assert summary["total_count"] == 250
        assert summary["verified_count"] == 250

    def test_one_failing_batch_does_not_void_the_others(self, monkeypatch):
        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))
        seen = {"calls": 0}

        def fake_run(script, *args, stdin_payload=None, **kwargs):
            seen["calls"] += 1
            items = json.loads(stdin_payload)["items"]
            if seen["calls"] == 2:
                return False, "", "터짐"
            return (
                True,
                json.dumps(
                    {
                        "items": [{"usage_id": item["usageId"], "verification_status": "verified"} for item in items],
                        "summary": {},
                    }
                ),
                "",
            )

        monkeypatch.setattr(svc, "run_besu_script", fake_run)
        rows = [(i, "returned") + (None,) * 23 for i in range(1, 2 * svc.VERIFY_BATCH_SIZE + 1)]

        results, _summary = svc.verify_usage_history_integrity(rows)

        assert results[1]["verification_status"] == "verified"
        assert results[svc.VERIFY_BATCH_SIZE + 1]["verification_status"] == "not_configured"


class TestBuildDefaultIntegrityResult:
    def test_labels_unreturned_records_as_in_use(self):
        result = svc.build_default_integrity_result(usage_status="checked_out", detail="무시됨")

        assert result["verification_status"] == "not_eligible"
        assert result["verification_label"] == "사용 중"

    def test_returned_records_keep_the_chain_label(self):
        result = svc.build_default_integrity_result(usage_status="returned", detail="이유")

        assert result["verification_label"] == "체인 미설정"


class TestBuildUsageHistoryVerificationRequest:
    def test_expected_is_none_when_not_returned(self):
        row = (1, "checked_out") + (None,) * 23

        result = svc.build_usage_history_verification_request(row)

        assert result["expected"] is None
        assert result["usageStatus"] == "checked_out"

    def test_builds_expected_payload_when_returned(self):
        row = [None] * 27
        row[0] = 1
        row[1] = "returned"
        row[2] = 10  # user_id
        row[6] = 20  # returned_by_user_id
        row[10] = "TAG-1"
        row[14] = "수술실"
        row[15] = 1_700_000_000
        row[17] = "영상의학과"
        row[18] = 1_700_003_600
        row[26] = [{"location": "수술실", "at": 1_700_000_500}]  # movement_path

        result = svc.build_usage_history_verification_request(tuple(row))

        assert result["expected"]["usageId"] == "1"
        assert result["expected"]["checkoutUserId"] == 10
        assert result["expected"]["returnUserId"] == 20
        assert result["expected"]["tagId"] == "TAG-1"
        assert result["expected"]["movementPath"] == [{"location": "수술실", "at": 1_700_000_500}]
