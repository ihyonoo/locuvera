"""백엔드 HTTP API 클라이언트: /ingest, /auth/login, /usage/checkout, /usage/return 호출.

체크아웃은 동시 호출을 허용하지만(체인 앵커링이 없음), 반납은 실제 온체인 앵커링을
트리거하고 동시 트랜잭션이 nonce 충돌을 일으킬 수 있어 simulator.py의 단일 워커가
항상 하나씩만 호출하게 만든다 — 이 클라이언트 자체는 동시성을 제어하지 않는다.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import time

import httpx

from simulation import config


class ApiClient:
    def __init__(self, base_url: str = config.BACKEND_BASE_URL):
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=config.HTTP_TIMEOUT_SEC)
        self._tokens: dict[str, tuple[str, float]] = {}

    async def ingest(self, payload: dict) -> None:
        if not config.RTLS_SIM_KEY:
            raise RuntimeError("RTLS_SIM_KEY가 설정되지 않았습니다.")
        reader_id = payload["reader_id"]
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        reader_key = hmac.new(
            config.RTLS_SIM_KEY.encode("utf-8"), f"rtls-sim-v1:{reader_id}".encode("ascii"), hashlib.sha256
        ).digest()
        body_hash = hashlib.sha256(body).hexdigest()
        for attempt in range(3):
            timestamp = str(int(time.time()))
            nonce = secrets.token_hex(16)
            message = f"v1\n{reader_id}\n{timestamp}\n{nonce}\n{body_hash}".encode("ascii")
            signature = hmac.new(reader_key, message, hashlib.sha256).hexdigest()
            headers = {
                "Content-Type": "application/json",
                "X-RTLS-Reader-ID": reader_id,
                "X-RTLS-Timestamp": timestamp,
                "X-RTLS-Nonce": nonce,
                "X-RTLS-Signature": signature,
            }
            try:
                response = await self._client.post(
                    "/ingest", content=body, headers=headers, timeout=config.INGEST_TIMEOUT_SEC
                )
            except httpx.TransportError:
                logging.getLogger("simulation.api_client").warning("RTLS 전송 실패", exc_info=True)
                return
            if response.status_code in (429, 503) and attempt < 2:
                await asyncio.sleep(0.25 * (attempt + 1))
                continue
            response.raise_for_status()
            return

    async def login(self, username: str, password: str) -> str:
        cached = self._tokens.get(username)
        if cached and cached[1] > time.time() + 60:
            return cached[0]

        response = await self._client.post(
            "/auth/login", json={"username": username, "password": password, "role": "staff"}
        )
        response.raise_for_status()
        body = response.json()
        token = body["token"]
        expires_at = body.get("expires_at", time.time() + 3600)
        self._tokens[username] = (token, expires_at)
        return token

    async def checkout(self, token: str, nfc_token: str) -> httpx.Response:
        return await self._client.post(
            "/usage/checkout",
            json={"nfc_token": nfc_token},
            headers={"Authorization": f"Bearer {token}"},
        )

    async def return_equipment(self, token: str, nfc_token: str) -> httpx.Response:
        return await self._client.post(
            "/usage/return",
            json={"nfc_token": nfc_token},
            headers={"Authorization": f"Bearer {token}"},
            timeout=config.RETURN_HTTP_TIMEOUT_SEC,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
