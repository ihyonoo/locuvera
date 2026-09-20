"""트레이스 저장소 — 수집한 관측과 참값을 SQLite에 담고 다시 읽는다.

표준 라이브러리만 쓰므로 의존성이 늘지 않고, 하루치 수천만 행도 인덱스를 걸어
질의할 수 있다. 시드와 커밋 해시를 meta에 함께 남겨 나중에 같은 트레이스를
다시 만들 수 있게 한다.
"""

import json
import sqlite3
from collections.abc import Iterable, Iterator
from pathlib import Path

from eval.metrics import TruthSample
from eval.positioning import Observation

SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
    seq INTEGER NOT NULL,
    recv_ts INTEGER NOT NULL,
    reader_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    rssi INTEGER NOT NULL,
    count INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS truth (
    ts INTEGER NOT NULL,
    tag_id TEXT NOT NULL,
    zone_a TEXT NOT NULL,
    zone_b TEXT NOT NULL,
    progress REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# 수집 중에는 인덱스를 만들지 않는다 — 수천만 행을 넣는 동안 갱신 비용만 커진다.
INDEXES = """
CREATE INDEX IF NOT EXISTS observations_seq ON observations (seq);
CREATE INDEX IF NOT EXISTS truth_tag ON truth (tag_id, ts);
"""


def open_trace(path: Path, *, create: bool = False) -> sqlite3.Connection:
    if create:
        path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    if create:
        connection.executescript(SCHEMA)
        # 수집은 한 번에 끝나고 중간에 죽으면 다시 돌리면 되므로, 내구성보다 속도를 택한다.
        connection.execute("PRAGMA journal_mode = OFF")
        connection.execute("PRAGMA synchronous = OFF")
    return connection


def write_meta(connection: sqlite3.Connection, meta: dict) -> None:
    connection.executemany(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        [(key, json.dumps(value, ensure_ascii=False)) for key, value in meta.items()],
    )
    connection.commit()


def read_meta(connection: sqlite3.Connection) -> dict:
    return {key: json.loads(value) for key, value in connection.execute("SELECT key, value FROM meta")}


def write_observations(connection: sqlite3.Connection, rows: Iterable[Observation]) -> None:
    connection.executemany("INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?)", rows)


def write_truth(connection: sqlite3.Connection, rows: Iterable[TruthSample]) -> None:
    connection.executemany("INSERT INTO truth (ts, tag_id, zone_a, zone_b, progress) VALUES (?, ?, ?, ?, ?)", rows)


def finalize(connection: sqlite3.Connection) -> None:
    connection.commit()
    connection.executescript(INDEXES)
    connection.commit()


def read_observations(connection: sqlite3.Connection) -> Iterator[Observation]:
    cursor = connection.execute(
        "SELECT seq, recv_ts, reader_id, tag_id, rssi, count, last_seen FROM observations ORDER BY seq"
    )
    for row in cursor:
        yield Observation(*row)


def read_truth(connection: sqlite3.Connection) -> Iterator[TruthSample]:
    cursor = connection.execute("SELECT ts, tag_id, zone_a, zone_b, progress FROM truth ORDER BY tag_id, ts")
    for row in cursor:
        yield TruthSample(*row)


def read_heard(connection: sqlite3.Connection) -> set[tuple[str, int]]:
    """어떤 리더든 그 태그를 들은 (tag_id, 초)의 집합."""
    return set(connection.execute("SELECT DISTINCT tag_id, recv_ts FROM observations"))
