"""재집계 — 기록해 둔 집계 이전 표본을 다른 리더 설정으로 다시 요약한다.

윈도우 길이와 집계 방식을 바꾸면 리더가 보냈을 관측 자체가 달라지므로, 서버
파라미터처럼 기록된 관측을 다시 해석하는 것만으로는 실험할 수 없다. 시뮬레이터가
쓰는 ReaderWindow를 그대로 불러 쓰므로 집계 규칙이 갈라지지 않는다.
"""

from collections.abc import Iterable, Iterator

from eval.positioning import Observation
from simulation.reader import DEFAULT_AGGREGATE, SEND_EVERY_SEC, WINDOW_SEC, ReaderWindow
from simulation.topology import zones


def reaggregate(
    raw_samples: Iterable[tuple[float, str, str, float]],
    *,
    window_sec: float = WINDOW_SEC,
    send_every_sec: float = SEND_EVERY_SEC,
    aggregate: str = DEFAULT_AGGREGATE,
) -> Iterator[Observation]:
    """시각 순으로 들어온 표본을 전송 주기마다 묶어 관측으로 내보낸다.

    리더 순서는 시뮬레이터가 페이로드를 만드는 순서와 같게 둔다. 같은 초에 여러 리더가
    보낸 관측의 처리 순서가 달라지면 판정 결과도 달라지기 때문이다.
    """
    windows = {zone.reader_id: ReaderWindow(zone.reader_id, window_sec, aggregate) for zone in zones.SIM_ZONES}
    seq = 0
    next_send = send_every_sec

    def emit(now: float) -> Iterator[Observation]:
        nonlocal seq
        for window in windows.values():
            payload = window.build_payload(now)
            if not payload["observations"]:
                continue
            seq += 1
            for observation in payload["observations"]:
                yield Observation(
                    seq=seq,
                    recv_ts=int(now),
                    reader_id=payload["reader_id"],
                    tag_id=observation["tag_id"],
                    rssi=observation["rssi"],
                    count=observation["count"],
                    last_seen=observation["last_seen"],
                )

    # 물리 틱의 시각은 0.2초씩 누적한 값이라 1.0, 2.0과 정확히 같지 않다. 수집 루프는
    # 전송 기한을 넘긴 첫 틱에서 그 틱의 시각으로 집계하므로, 재집계도 표본에 남은 틱
    # 시각을 그대로 시계로 써야 같은 윈도우가 나온다.
    tick: float | None = None
    for ts, reader_id, tag_id, rssi in raw_samples:
        if tick is not None and ts != tick and tick >= next_send:
            yield from emit(tick)
            next_send += send_every_sec
        windows[reader_id].add(tag_id, rssi, ts)
        tick = ts

    if tick is not None and tick >= next_send:
        yield from emit(tick)
