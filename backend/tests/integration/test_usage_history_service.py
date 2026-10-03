"""usage_history_service의 DB I/O 통합 테스트.

subprocess/Node 스크립트 호출은 모두 monkeypatch로 치환해 진짜 프로세스를
띄우지 않는다 - 여기서 검증하려는 건 실제 psycopg 연결을 쓰는 조회/기록 로직이다.
"""

import datetime as dt
import json

from backend import usage_history_service as svc


def _insert_usage_history(
    db_conn,
    *,
    tag_id: str,
    user_id: int,
    returned: bool,
    returned_by_user_id: int | None = None,
    checkout_location: str = "수술실",
    return_location: str | None = "영상의학과",
    movement_path: list | None = None,
) -> int:
    checkout_at = dt.datetime.now(dt.UTC).replace(microsecond=0) - dt.timedelta(hours=1)
    returned_at = dt.datetime.now(dt.UTC).replace(microsecond=0) if returned else None
    with db_conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO usage_history (
                usage_status, user_id, user_name, tag_id, equipment_name,
                checkout_method, checkout_location, checkout_at,
                return_method, returned_by_user_id, return_location, returned_at,
                movement_path
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING usage_id
            """,
            (
                "returned" if returned else "checked_out",
                user_id,
                "테스트 사용자",
                tag_id,
                "테스트 장비",
                "nfc",
                checkout_location,
                checkout_at,
                "nfc" if returned else None,
                returned_by_user_id,
                return_location if returned else None,
                returned_at,
                json.dumps(movement_path) if movement_path is not None else None,
            ),
        )
        usage_id = cur.fetchone()[0]
    db_conn.commit()
    return usage_id


class TestFetchUsageRecordForChain:
    def test_returns_payload_for_returned_usage(self, db_conn, seed_tag, seed_user):
        tag_id = seed_tag(nfc_token="NFC-100")
        user_id, _headers = seed_user(username="checkout-user")
        returner_id, _headers2 = seed_user(username="return-user")
        usage_id = _insert_usage_history(
            db_conn,
            tag_id=tag_id,
            user_id=user_id,
            returned=True,
            returned_by_user_id=returner_id,
        )

        payload = svc.fetch_usage_record_for_chain(usage_id)

        assert payload is not None
        assert payload["usageId"] == str(usage_id)
        assert payload["checkoutUserId"] == user_id
        assert payload["returnUserId"] == returner_id
        assert payload["tagId"] == tag_id
        assert payload["checkoutLocation"] == "수술실"
        assert payload["returnLocation"] == "영상의학과"
        assert isinstance(payload["checkoutAt"], int)
        assert isinstance(payload["returnedAt"], int)
        assert payload["movementPath"] == []

    def test_includes_movement_path_when_present(self, db_conn, seed_tag, seed_user):
        tag_id = seed_tag(nfc_token="NFC-106")
        user_id, _headers = seed_user(username="path-checkout")
        returner_id, _headers2 = seed_user(username="path-return")
        path = [{"location": "수술실", "at": 1_700_000_100}, {"location": "회복실", "at": 1_700_000_200}]
        usage_id = _insert_usage_history(
            db_conn,
            tag_id=tag_id,
            user_id=user_id,
            returned=True,
            returned_by_user_id=returner_id,
            movement_path=path,
        )

        payload = svc.fetch_usage_record_for_chain(usage_id)

        assert payload["movementPath"] == path

    def test_returns_none_when_not_returned(self, db_conn, seed_tag, seed_user):
        tag_id = seed_tag(nfc_token="NFC-101")
        user_id, _headers = seed_user(username="checkout-only")
        usage_id = _insert_usage_history(db_conn, tag_id=tag_id, user_id=user_id, returned=False)

        payload = svc.fetch_usage_record_for_chain(usage_id)

        assert payload is None

    def test_returns_none_for_unknown_usage_id(self):
        assert svc.fetch_usage_record_for_chain(999_999_999) is None


class TestPersistUsageChainAnchorMetadata:
    def test_writes_anchor_fields_to_db(self, db_conn, seed_tag, seed_user):
        tag_id = seed_tag(nfc_token="NFC-102")
        user_id, _headers = seed_user(username="anchor-user")
        returner_id, _ = seed_user(username="anchor-returner")
        usage_id = _insert_usage_history(
            db_conn, tag_id=tag_id, user_id=user_id, returned=True, returned_by_user_id=returner_id
        )

        svc.persist_usage_chain_anchor_metadata(
            usage_id,
            {
                "transaction_hash": "0xabc123",
                "block_number": 42,
                "block_hash": "0xblockhash",
                "transaction_index": 3,
                "recorded_at": 1_700_003_600,
            },
        )

        with db_conn.cursor() as cur:
            cur.execute(
                """
                SELECT blockchain_tx_hash, blockchain_block_number, blockchain_block_hash,
                       blockchain_transaction_index, blockchain_recorded_at
                FROM usage_history WHERE usage_id = %s
                """,
                (usage_id,),
            )
            tx_hash, block_number, block_hash, tx_index, recorded_at = cur.fetchone()

        assert tx_hash == "0xabc123"
        assert block_number == 42
        assert block_hash == "0xblockhash"
        assert tx_index == 3
        assert recorded_at is not None

    def test_noop_when_anchor_result_has_no_tx_hash(self, db_conn, seed_tag, seed_user):
        tag_id = seed_tag(nfc_token="NFC-103")
        user_id, _headers = seed_user(username="noop-user")
        usage_id = _insert_usage_history(
            db_conn, tag_id=tag_id, user_id=user_id, returned=True, returned_by_user_id=user_id
        )

        svc.persist_usage_chain_anchor_metadata(usage_id, {"status": "not_configured", "detail": "이유"})

        with db_conn.cursor() as cur:
            cur.execute("SELECT blockchain_tx_hash FROM usage_history WHERE usage_id = %s", (usage_id,))
            (tx_hash,) = cur.fetchone()
        assert tx_hash is None

    def test_swallows_errors_for_unknown_usage_id(self):
        # usage_id가 존재하지 않아도 UPDATE는 0행에 영향을 주고 조용히 반환된다(예외 없음).
        svc.persist_usage_chain_anchor_metadata(
            999_999_999,
            {
                "transaction_hash": "0xabc",
                "block_number": 1,
                "block_hash": "0xb",
                "transaction_index": 0,
                "recorded_at": None,
            },
        )

    def test_logs_when_db_write_fails(self, monkeypatch, caplog):
        # DB 오류는 여전히 우아하게 삼켜야 하지만(예외 미전파), 아무 흔적도 안 남기면
        # 앵커링은 성공했는데 tx_hash 저장만 실패한 상황을 디버깅할 수 없다.
        def fake_connect(*args, **kwargs):
            raise RuntimeError("DB 연결 실패")

        monkeypatch.setattr(svc.psycopg, "connect", fake_connect)

        with caplog.at_level("ERROR", logger="mediledger.usage_history"):
            svc.persist_usage_chain_anchor_metadata(
                1,
                {
                    "transaction_hash": "0xabc",
                    "block_number": 1,
                    "block_hash": "0xb",
                    "transaction_index": 0,
                    "recorded_at": None,
                },
            )

        assert any("1" in record.getMessage() for record in caplog.records)


class TestAnchorUsageRecordToChainEndToEnd:
    """실 DB 조회(fetch_usage_record_for_chain) + mocked subprocess로 전체 앵커링 흐름을 검증."""

    def test_anchors_and_persists_when_besu_ready(self, db_conn, seed_tag, seed_user, monkeypatch):
        tag_id = seed_tag(nfc_token="NFC-104")
        user_id, _headers = seed_user(username="e2e-checkout")
        returner_id, _headers2 = seed_user(username="e2e-return")
        usage_id = _insert_usage_history(
            db_conn, tag_id=tag_id, user_id=user_id, returned=True, returned_by_user_id=returner_id
        )

        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (True, None))

        def fake_run_besu_script(script_name, *args, stdin_payload=None, **kwargs):
            if script_name == "read-usage-record.mjs":
                return True, json.dumps({"exists": False}), ""
            if script_name == "record-usage-record.mjs":
                return (
                    True,
                    json.dumps(
                        {
                            "txHash": "0xe2e",
                            "blockNumber": 7,
                            "blockHash": "0xe2eblock",
                            "transactionIndex": 1,
                            "recordedAt": 1_700_005_000,
                        }
                    ),
                    "",
                )
            raise AssertionError(f"unexpected script: {script_name}")

        monkeypatch.setattr(svc, "run_besu_script", fake_run_besu_script)

        result = svc.anchor_usage_record_to_chain(usage_id)
        assert result["ok"] is True
        assert result["status"] == "anchored"
        assert result["transaction_hash"] == "0xe2e"

        svc.persist_usage_chain_anchor_metadata(usage_id, result)

        with db_conn.cursor() as cur:
            cur.execute(
                "SELECT blockchain_tx_hash, blockchain_block_number FROM usage_history WHERE usage_id = %s",
                (usage_id,),
            )
            tx_hash, block_number = cur.fetchone()
        assert tx_hash == "0xe2e"
        assert block_number == 7

    def test_degrades_gracefully_when_besu_not_configured(self, db_conn, seed_tag, seed_user, monkeypatch):
        tag_id = seed_tag(nfc_token="NFC-105")
        user_id, _headers = seed_user(username="degrade-user")
        usage_id = _insert_usage_history(
            db_conn, tag_id=tag_id, user_id=user_id, returned=True, returned_by_user_id=user_id
        )

        monkeypatch.setattr(svc, "is_besu_ready", lambda **_kwargs: (False, "체인 미배포"))
        subprocess_calls = []
        monkeypatch.setattr(svc, "run_besu_script", lambda *a, **k: subprocess_calls.append(a) or (True, "{}", ""))

        result = svc.anchor_usage_record_to_chain(usage_id)

        assert result == {"ok": False, "status": "not_configured", "detail": "체인 미배포"}
        assert subprocess_calls == []

        # 저장 함수 역시 tx_hash가 없으니 조용히 아무것도 쓰지 않아야 한다.
        svc.persist_usage_chain_anchor_metadata(usage_id, result)
        with db_conn.cursor() as cur:
            cur.execute("SELECT blockchain_tx_hash FROM usage_history WHERE usage_id = %s", (usage_id,))
            (tx_hash,) = cur.fetchone()
        assert tx_hash is None


class TestQueryUsageHistoryRowsMovementPath:
    def test_build_usage_history_item_includes_movement_path(self, db_conn, seed_tag, seed_user):
        tag_id = seed_tag(nfc_token="NFC-107")
        user_id, _headers = seed_user(username="list-checkout")
        returner_id, _headers2 = seed_user(username="list-return")
        path = [{"location": "수술실", "at": 1_700_000_100}]
        usage_id = _insert_usage_history(
            db_conn,
            tag_id=tag_id,
            user_id=user_id,
            returned=True,
            returned_by_user_id=returner_id,
            movement_path=path,
        )

        _limit, _offset, _total, rows = svc.query_usage_history_rows(
            user=None,
            equipment=None,
            checkout_location=None,
            return_location=None,
            date=None,
            start_date=None,
            end_date=None,
            sort_by="time",
            sort_order="desc",
            limit=10,
            max_limit=200,
        )
        row = next(r for r in rows if r[0] == usage_id)
        item = svc.build_usage_history_item(row)

        assert item["movement_path"] == path

    def test_build_my_usage_history_item_includes_movement_path(self, db_conn, seed_tag, seed_user):
        tag_id = seed_tag(nfc_token="NFC-108")
        user_id, _headers = seed_user(username="mine-checkout")
        path = [{"location": "회복실", "at": 1_700_000_200}]
        _insert_usage_history(db_conn, tag_id=tag_id, user_id=user_id, returned=True, movement_path=path)

        rows = svc.query_my_usage_history_rows(user_id=user_id, limit=10)
        item = svc.build_my_usage_history_item(rows[0])

        assert item["movement_path"] == path
