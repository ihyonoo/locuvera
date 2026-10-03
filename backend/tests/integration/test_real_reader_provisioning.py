from pathlib import Path

SQL = Path(__file__).resolve().parents[3] / "database" / "provision_real_readers.sql"


def test_real_reader_provisioning_is_idempotent_and_preserves_existing_disable(db_conn):
    with db_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO readers (reader_id, location_name, is_active, is_real_hardware) "
            "VALUES ('M501', '직접 지정한 위치', FALSE, FALSE)"
        )
        cur.execute(SQL.read_text())
        cur.execute(
            "SELECT reader_id, location_name, floor, is_active, is_real_hardware FROM readers ORDER BY reader_id"
        )
        assert cur.fetchall() == [
            ("M501", "직접 지정한 위치", 5, False, True),
            ("M502", "통원수술센터", 5, True, True),
        ]
        cur.execute("UPDATE readers SET is_active = FALSE WHERE reader_id = 'M501'")
        cur.execute(SQL.read_text())
        cur.execute("SELECT is_active FROM readers WHERE reader_id = 'M501'")
        assert cur.fetchone() == (False,)
