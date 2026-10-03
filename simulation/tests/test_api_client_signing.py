import asyncio
import hashlib
import hmac

import httpx

from simulation import config
from simulation.api_client import ApiClient


def test_simulator_ingest_uses_reader_specific_signed_body(monkeypatch):
    monkeypatch.setattr(config, "RTLS_SIM_KEY", "simulation-test-master")
    captured = []

    def receive(request):
        captured.append(request)
        return httpx.Response(200, json={"ok": True})

    async def exercise():
        client = ApiClient("http://test")
        await client._client.aclose()
        client._client = httpx.AsyncClient(base_url="http://test", transport=httpx.MockTransport(receive))
        try:
            await client.ingest({"reader_id": "M101", "ts": 100, "observations": []})
        finally:
            await client.aclose()

    asyncio.run(exercise())

    request = captured[0]
    reader_key = hmac.new(b"simulation-test-master", b"rtls-sim-v1:M101", hashlib.sha256).digest()
    message = (
        f"v1\nM101\n{request.headers['X-RTLS-Timestamp']}\n"
        f"{request.headers['X-RTLS-Nonce']}\n{hashlib.sha256(request.content).hexdigest()}"
    ).encode()
    assert request.headers["X-RTLS-Reader-ID"] == "M101"
    assert hmac.compare_digest(
        request.headers["X-RTLS-Signature"], hmac.new(reader_key, message, hashlib.sha256).hexdigest()
    )


def test_simulator_retries_temporary_rejection_with_a_new_nonce(monkeypatch):
    monkeypatch.setattr(config, "RTLS_SIM_KEY", "simulation-test-master")
    captured = []

    def receive(request):
        captured.append(request)
        return httpx.Response(503 if len(captured) == 1 else 200, json={"ok": True})

    async def exercise():
        client = ApiClient("http://test")
        await client._client.aclose()
        client._client = httpx.AsyncClient(base_url="http://test", transport=httpx.MockTransport(receive))
        try:
            await client.ingest({"reader_id": "M101", "ts": 100, "observations": []})
        finally:
            await client.aclose()

    asyncio.run(exercise())

    assert len(captured) == 2
    assert captured[0].headers["X-RTLS-Nonce"] != captured[1].headers["X-RTLS-Nonce"]
