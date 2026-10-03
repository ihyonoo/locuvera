"""상시 가동 시뮬레이터 진입점.

네 개의 루프를 하나의 asyncio 프로세스로 돌린다.
  - 물리 200ms: 태그 브로드캐스트 1회 = 위치 갱신 + 근처 리더별 RSSI 샘플
  - 리더 1초: 리더 42개가 각자 2초 윈도우 median을 POST /ingest (실물과 동일)
  - 행동 10초: 대여 판정과 상태 머신 전이
  - 반납 워커: 온체인 앵커링 nonce 충돌을 피하려 항상 하나씩만 처리

기동 후 DB에 접근하지 않는다. 시드는 python -m simulation.apply_seed가 따로 넣는다.

실행: python -m simulation.simulator (저장소 루트에서, simulation/.env 필요)
"""

import asyncio
import datetime as dt
import random
import signal
import time
import traceback

import httpx

from simulation import config, world
from simulation.api_client import ApiClient
from simulation.reader import SEND_EVERY_SEC


async def _tick_forever(name: str, interval: float, step) -> None:
    """드리프트를 보정하며 고정 주기로 step을 부른다.

    루프가 조용히 죽으면 나머지 루프만 계속 돌아 겉보기엔 정상으로 보인다 —
    어느 루프가 왜 죽었는지 반드시 남기고 예외를 그대로 올려보낸다.
    """
    next_at = time.monotonic()
    while True:
        next_at += interval
        try:
            await step()
        except asyncio.CancelledError:
            raise
        except Exception:
            print(f"[simulator] {name} loop crashed:")
            traceback.print_exc()
            raise
        await asyncio.sleep(max(0.0, next_at - time.monotonic()))


async def run_physics_loop(state: world.World) -> None:
    async def step() -> None:
        state.tick_physics(time.time(), world.PHYSICS_TICK_SEC)

    await _tick_forever("physics", world.PHYSICS_TICK_SEC, step)


async def run_reader_loop(state: world.World, api: ApiClient) -> None:
    async def step() -> None:
        payloads = state.collect_payloads(time.time())
        await asyncio.gather(*(api.ingest(payload) for payload in payloads))

    await _tick_forever("reader", SEND_EVERY_SEC, step)


async def run_behavior_loop(state: world.World, api: ApiClient, return_queue: asyncio.Queue) -> None:
    async def step() -> None:
        now = time.time()
        moment = dt.datetime.now(dt.UTC)
        for command in state.tick_behavior(moment, now):
            await _do_checkout(state, api, command)
        for command in state.due_returns(moment, now):
            await return_queue.put(command)

    await _tick_forever("behavior", world.BEHAVIOR_TICK_SEC, step)


async def _do_checkout(state: world.World, api: ApiClient, command: world.CheckoutCommand) -> None:
    try:
        token = await api.login(command.username, config.SIM_STAFF_PASSWORD)
        response = await api.checkout(token, command.nfc_token)
    except httpx.HTTPError as error:
        print(f"[simulator] checkout {command.nfc_token} failed: {error}")
        state.reject_checkout(command.tag_id, time.time())
        return
    if response.status_code == 200:
        state.confirm_checkout(command.tag_id, time.time())
    elif response.status_code == 409:
        # DB엔 이미 이 태그가 대여 중이다 — 월드가 모르는 사용 이력이므로 되돌리지 말고 흡수해 반납으로 정리한다.
        print(f"[simulator] checkout {command.nfc_token} already taken (409) — adopted for return")
        state.adopt_checked_out(command.tag_id, time.time())
    else:
        print(f"[simulator] checkout {command.nfc_token} rejected: {response.status_code}")
        state.reject_checkout(command.tag_id, time.time())


async def run_return_worker(state: world.World, api: ApiClient, return_queue: asyncio.Queue) -> None:
    """항상 하나씩만 처리한다 — 반납이 온체인 앵커링을 트리거하고 동시 트랜잭션은
    nonce 충돌을 일으킨다. 대여한 것은 반드시 반납되어야 하므로 실패하면 재시도한다."""
    while True:
        command = await return_queue.get()
        try:
            token = await api.login(command.username, config.SIM_STAFF_PASSWORD)
            response = await api.return_equipment(token, command.nfc_token)
            if response.status_code == 200:
                state.confirm_return(command.tag_id, time.time())
            elif response.status_code == 409:
                # DB엔 이미 반납 처리돼 있다 — 월드-DB 상태 불일치이지 실패가 아니므로 재시도하지 않고 확정한다.
                state.confirm_return(command.tag_id, time.time())
                print(f"[simulator] return {command.nfc_token} already settled (409) — reconciled")
            else:
                print(f"[simulator] return {command.nfc_token} rejected: {response.status_code}")
                state.retry_return(command.tag_id, time.time())
        except httpx.HTTPError as error:
            print(f"[simulator] return {command.nfc_token} failed: {error}")
            state.retry_return(command.tag_id, time.time())
        except Exception:
            print(f"[simulator] return worker crashed on {command.nfc_token}:")
            traceback.print_exc()
            state.retry_return(command.tag_id, time.time())
            raise
        finally:
            return_queue.task_done()


async def run() -> None:
    if not config.SIM_STAFF_PASSWORD:
        raise SystemExit("SIM_STAFF_PASSWORD 환경변수가 필요합니다 (simulation/.env 참고).")

    rng = random.Random(config.SIM_RANDOM_SEED)
    state = world.World(rng=rng, now=time.time())
    api = ApiClient()
    return_queue: asyncio.Queue = asyncio.Queue()

    print(f"[simulator] {len(state.tags)} tags, {len(state.windows)} readers")

    tasks = [
        asyncio.create_task(run_physics_loop(state)),
        asyncio.create_task(run_reader_loop(state, api)),
        asyncio.create_task(run_behavior_loop(state, api, return_queue)),
        asyncio.create_task(run_return_worker(state, api, return_queue)),
    ]

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    print("[simulator] running")
    stop_task = asyncio.create_task(stop_event.wait())
    # 정지 신호와 루프들을 함께 기다린다 — 루프가 죽으면 데몬이 반쯤 살아있는 채로
    # 남지 않고 즉시 내려간다.
    await asyncio.wait([stop_task, *tasks], return_when=asyncio.FIRST_COMPLETED)
    stop_task.cancel()

    print("[simulator] stopping...")
    for task in tasks:
        task.cancel()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    await api.aclose()
    print("[simulator] stopped")
    for result in results:
        if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
            raise result


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
