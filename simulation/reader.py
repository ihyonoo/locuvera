"""리더 에뮬레이션 — 2초 윈도우 median 집계 후 1초마다 보낼 페이로드를 만든다.

실물 rtls/rtls_reader/send_to_server.py와 같은 규격이다(WINDOW_SEC=2.0,
SEND_EVERY_SEC=1.0, rssi=median, count=샘플 수). 한 가지만 다르다 — 실물은 관측이
0건이면 POST를 건너뛰지만 여기서는 빈 페이로드를 보낸다. 백엔드가 관측 루프보다 먼저
리더를 upsert하므로 이게 하트비트가 되어, 장비가 없는 구역의 리더도 온라인으로 남는다.

윈도우 길이와 집계 방식은 인자로 받는다. 기본값이 실물 규격과 같으므로 시뮬레이터의
동작은 달라지지 않고, 평가에서 같은 원시 표본을 다른 설정으로 다시 집계할 수 있다.
"""

import statistics
from collections import defaultdict
from collections.abc import Callable, Sequence

WINDOW_SEC = 2.0
SEND_EVERY_SEC = 1.0

AGGREGATORS: dict[str, Callable[[Sequence[float]], float]] = {
    "median": statistics.median,
    "mean": statistics.fmean,
    "max": max,
    "min": min,
}
DEFAULT_AGGREGATE = "median"


class ReaderWindow:
    def __init__(
        self,
        reader_id: str,
        window_sec: float = WINDOW_SEC,
        aggregate: str = DEFAULT_AGGREGATE,
    ) -> None:
        self.reader_id = reader_id
        self.window_sec = window_sec
        self.aggregate = AGGREGATORS[aggregate]
        self._samples: dict[str, list[tuple[float, float]]] = defaultdict(list)

    def add(self, tag_id: str, rssi: float, at: float) -> None:
        self._samples[tag_id].append((at, rssi))

    def build_payload(self, now: float) -> dict:
        cutoff = now - self.window_sec
        observations = []
        for tag_id in list(self._samples):
            fresh = [(at, rssi) for at, rssi in self._samples[tag_id] if at >= cutoff]
            if not fresh:
                del self._samples[tag_id]
                continue
            self._samples[tag_id] = fresh
            observations.append(
                {
                    "tag_id": tag_id,
                    "rssi": int(self.aggregate([rssi for _, rssi in fresh])),
                    "count": len(fresh),
                    "last_seen": int(max(at for at, _ in fresh)),
                }
            )
        return {"reader_id": self.reader_id, "ts": int(now), "observations": observations}
