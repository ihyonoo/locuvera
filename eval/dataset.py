"""트레이스를 정수 배열로 압축해 메모리에 올린다.

조합마다 SQLite를 다시 읽으면 1,355만 행을 735번 읽게 되고, 행마다 객체를 만들면
워커 하나가 수 GB를 쓴다. 태그 50개와 구역 41개는 한 바이트에 들어가고 시각은
하루가 86,400초이므로, 관측 한 건이 8바이트면 충분하다.

구역 이름과 리더 ID는 같은 어휘를 쓴다. 구역마다 리더가 한 대씩이라 판정된 리더를
그대로 구역으로 볼 수 있고, 지표 계산이 정수 비교로 끝난다.
"""

import sqlite3
from array import array
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Vocabulary:
    """문자열 ID를 정수 인덱스로 바꾼다."""

    names: list[str] = field(default_factory=list)
    _index: dict[str, int] = field(default_factory=dict)

    def intern(self, name: str) -> int:
        index = self._index.get(name)
        if index is None:
            index = len(self.names)
            self._index[name] = index
            self.names.append(name)
        return index

    def __len__(self) -> int:
        return len(self.names)


@dataclass
class TagTruth:
    """한 태그의 참값 궤적. 모두 같은 길이의 평행 배열이다."""

    ts: array
    zone_a: array
    zone_b: array
    heard: bytearray

    def was_heard(self, ts: int) -> bool:
        byte, bit = divmod(ts, 8)
        return byte < len(self.heard) and bool(self.heard[byte] & (1 << bit))


@dataclass
class Dataset:
    zones: Vocabulary
    tags: Vocabulary
    obs_ts: array
    obs_reader: array
    obs_tag: array
    obs_rssi: array
    truth: list[TagTruth]

    @property
    def observation_count(self) -> int:
        return len(self.obs_ts)

    @property
    def truth_count(self) -> int:
        return sum(len(entry.ts) for entry in self.truth)


def build(observations: Iterable[tuple[int, str, str, int]], truth_for) -> Dataset:
    """관측과 참값을 압축 배열로 담는다.

    관측은 (수신 시각, 리더, 태그, 신호 세기)를 처리 순서대로 준다. 참값은 관측 구간이
    정해진 뒤에 읽어야 하므로, 마지막 시각을 받아 행을 돌려주는 함수로 준다 —
    원시 표본을 앞 구간만 남긴 트레이스에서 참값이 관측보다 길어지지 않게 한다.

    태그가 어느 리더에도 잡히지 않은 초는 heard 비트맵에서 빠진다.
    """
    zones = Vocabulary()
    tags = Vocabulary()
    obs_ts, obs_reader, obs_tag, obs_rssi = array("i"), array("B"), array("B"), array("h")

    for recv_ts, reader_id, tag_id, rssi in observations:
        obs_ts.append(recv_ts)
        obs_reader.append(zones.intern(reader_id))
        obs_tag.append(tags.intern(tag_id))
        obs_rssi.append(rssi)

    horizon = max(obs_ts) if obs_ts else 0

    per_tag: dict[int, TagTruth] = {}
    for ts, tag_id, zone_a, zone_b in truth_for(horizon):
        entry = per_tag.get(tags.intern(tag_id))
        if entry is None:
            entry = per_tag[tags.intern(tag_id)] = TagTruth(array("i"), array("h"), array("h"), bytearray())
        entry.ts.append(ts)
        entry.zone_a.append(zones.intern(zone_a))
        entry.zone_b.append(zones.intern(zone_b))
        horizon = max(horizon, ts)

    for entry in per_tag.values():
        entry.heard = bytearray(horizon // 8 + 1)
    for position in range(len(obs_ts)):
        entry = per_tag.get(obs_tag[position])
        if entry is None:
            continue
        byte, bit = divmod(obs_ts[position], 8)
        entry.heard[byte] |= 1 << bit

    # 태그 인덱스로 바로 꺼낼 수 있도록 어휘 길이에 맞춘다 — 관측에만 있고 참값에 없는
    # 태그가 있으면 자리를 비워 두되 인덱스는 어긋나지 않게 한다.
    empty = TagTruth(array("i"), array("h"), array("h"), bytearray())
    return Dataset(
        zones=zones,
        tags=tags,
        obs_ts=obs_ts,
        obs_reader=obs_reader,
        obs_tag=obs_tag,
        obs_rssi=obs_rssi,
        truth=[per_tag.get(index, empty) for index in range(len(tags))],
    )


def load(path: Path) -> Dataset:
    """트레이스에 기록된 관측 그대로 압축본을 만든다."""
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return build(
            connection.execute("SELECT recv_ts, reader_id, tag_id, rssi FROM observations ORDER BY seq"),
            lambda horizon: connection.execute(
                "SELECT ts, tag_id, zone_a, zone_b FROM truth WHERE ts <= ? ORDER BY tag_id, ts", (horizon,)
            ),
        )
    finally:
        connection.close()
