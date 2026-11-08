"""리더 에뮬레이션 — 5초 윈도우 median 집계 후 1초마다 보낼 페이로드를 만든다.

실물 rtls/rtls_reader/send_to_server.py와 같은 규격이다(WINDOW_SEC=5.0,
SEND_EVERY_SEC=1.0, rssi=median, count=샘플 수). 한 가지만 다르다 — 실물은 관측이
0건이면 POST를 건너뛰지만 여기서는 빈 페이로드를 보낸다. 백엔드가 관측 루프보다 먼저
리더를 upsert하므로 이게 하트비트가 되어, 장비가 없는 구역의 리더도 온라인으로 남는다.

윈도우 길이와 집계 방식은 인자로 받는다. 기본값이 실물 규격과 같으므로 시뮬레이터의
동작은 달라지지 않고, 평가에서 같은 원시 표본을 다른 설정으로 다시 집계할 수 있다.
"""

import hashlib
import statistics
from collections import defaultdict
from collections.abc import Callable, Sequence

WINDOW_SEC = 5.0
SEND_EVERY_SEC = 1.0

AGGREGATORS: dict[str, Callable[[Sequence[float]], float]] = {
    "median": statistics.median,
    "mean": statistics.fmean,
    "max": max,
    "min": min,
}
DEFAULT_AGGREGATE = "median"

# 태그 배터리 잔량 하한(%). 장비마다 전지 교체 시기가 달라 잔량이 넓게 퍼진다
BATTERY_MIN_PCT = 15


def tag_battery_pct(tag_id: str) -> int:
    """태그 ID로 정해지는 고정 잔량(15~100%). 재시작해도 같은 값이다."""
    digest = hashlib.sha256(tag_id.encode()).digest()
    return BATTERY_MIN_PCT + int.from_bytes(digest[:2], "big") % (101 - BATTERY_MIN_PCT)


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
                    "battery_pct": tag_battery_pct(tag_id),
                }
            )
        return {"reader_id": self.reader_id, "ts": int(now), "observations": observations}
