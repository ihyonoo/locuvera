"""변조 탐지 시연: 변조·복구 SQL과, 어떤 경로로 끝나도 원래 값으로 되돌리는지."""

import json

import pytest

from tools.exhibit.tamper_demo import Tamper, UsageSnapshot, restore_sql, tamper_sql

ORIGINAL = "2026-11-02 14:41:07.512345+00"
SNAPSHOT = UsageSnapshot(
    usage_id=3251,
    equipment_name="수액펌프-001",
    returned_at=ORIGINAL,
    returned_epoch=1_762_094_468,
    checkout_date="2026-11-02",
)


class FakeDb:
    def __init__(self, fail_on=None):
        self.statements: list[str] = []
        self.fail_on = fail_on

    def __call__(self, sql: str) -> str:
        self.statements.append(sql)
        if self.fail_on and self.fail_on in sql and self.statements.count(sql) == 1:
            raise RuntimeError("ssh 연결 끊김")
        return "UPDATE 1"


def test_tamper_moves_the_return_time_later():
    # 앞당기면 짧은 기록은 returned_at >= checkout_at 제약에 걸린다
    assert tamper_sql(3251, ORIGINAL, 2) == (
        "UPDATE usage_history SET returned_at = '2026-11-02 14:41:07.512345+00'::timestamptz + interval '2 hours' "
        "WHERE usage_id = 3251 AND usage_status = 'returned';"
    )


def test_restore_puts_back_the_exact_original():
    assert restore_sql(3251, ORIGINAL) == (
        "UPDATE usage_history SET returned_at = '2026-11-02 14:41:07.512345+00'::timestamptz "
        "WHERE usage_id = 3251 AND usage_status = 'returned';"
    )


@pytest.mark.parametrize("bad", ["2026-11-02'; DROP TABLE tags; --", "", "now()"])
def test_refuses_anything_but_a_timestamp(bad):
    with pytest.raises(ValueError):
        restore_sql(3251, bad)


def test_restores_after_the_block_ends(tmp_path):
    db = FakeDb()
    backup = tmp_path / "3251.json"

    with Tamper(db, SNAPSHOT, shift_hours=2, backup_path=backup):
        assert db.statements == [tamper_sql(3251, ORIGINAL, 2)]
        assert json.loads(backup.read_text())["returned_at"] == ORIGINAL

    assert db.statements[-1] == restore_sql(3251, ORIGINAL)
    assert not backup.exists()


@pytest.mark.parametrize("interrupt", [KeyboardInterrupt, RuntimeError])
def test_restores_when_interrupted(tmp_path, interrupt):
    db = FakeDb()

    with pytest.raises(interrupt), Tamper(db, SNAPSHOT, shift_hours=2, backup_path=tmp_path / "b.json"):
        raise interrupt()

    assert db.statements[-1] == restore_sql(3251, ORIGINAL)


def test_restores_even_when_the_tamper_reply_is_lost(tmp_path):
    # 변조가 서버에서 커밋됐는데 응답만 끊겼을 수 있다 — 원래 값을 다시 넣어 둔다
    db = FakeDb(fail_on="interval")

    with pytest.raises(RuntimeError), Tamper(db, SNAPSHOT, shift_hours=2, backup_path=tmp_path / "b.json"):
        pass

    assert db.statements[-1] == restore_sql(3251, ORIGINAL)


def test_keeps_the_backup_when_the_restore_fails(tmp_path):
    db = FakeDb(fail_on="::timestamptz WHERE")
    backup = tmp_path / "b.json"

    with pytest.raises(RuntimeError), Tamper(db, SNAPSHOT, shift_hours=2, backup_path=backup):
        pass

    assert backup.exists()
