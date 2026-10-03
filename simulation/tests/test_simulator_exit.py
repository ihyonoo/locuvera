import asyncio
from types import SimpleNamespace

import pytest

from simulation import simulator


def test_failed_core_loop_propagates_after_cleanup(monkeypatch):
    monkeypatch.setattr(simulator.config, "SIM_STAFF_PASSWORD", "test-password")
    monkeypatch.setattr(simulator.world, "World", lambda **_kwargs: SimpleNamespace(tags=[], windows=[]))
    closed = []

    class FakeApi:
        async def aclose(self):
            closed.append(True)

    monkeypatch.setattr(simulator, "ApiClient", FakeApi)

    async def fail(_state):
        raise RuntimeError("physics failed")

    async def wait_forever(*_args):
        await asyncio.Event().wait()

    monkeypatch.setattr(simulator, "run_physics_loop", fail)
    monkeypatch.setattr(simulator, "run_reader_loop", wait_forever)
    monkeypatch.setattr(simulator, "run_behavior_loop", wait_forever)
    monkeypatch.setattr(simulator, "run_return_worker", wait_forever)

    with pytest.raises(RuntimeError, match="physics failed"):
        asyncio.run(simulator.run())
    assert closed == [True]
