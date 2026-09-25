"""RPC 노드를 장악한 공격자를 흉내 내는 프록시.

검증 스크립트는 체인에 묻는 모든 질문을 RPC 노드 하나로 보내고, 그 주소는 환경변수
BESU_RPC_URL로만 정해진다. 그 사이에 이 프록시를 끼우고 지정한 메서드의 응답을 바꾸면,
노드 내부를 건드리지 않고도 "장악된 노드"가 된다.

무결성 평가의 등급 C 시나리오가 이 프록시 위에서 돈다. 계층을 하나씩 속여 가며 다음
계층이 잡아내는지를 확인하는 것이 목적이다.
"""

import json
import threading
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FORWARD_TIMEOUT_SEC = 30


@dataclass(frozen=True)
class Rule:
    """응답을 바꿀 메서드와 바꾸는 방법.

    apply는 원래 result를 받아 바꾼 result를 돌려준다. 요청 params도 함께 받으므로
    "이 usage_id를 물었을 때만 위조" 같은 조건을 걸 수 있다.
    """

    method: str
    apply: Callable[[object, list], object]


class TamperingProxy:
    """upstream으로 요청을 넘기고, 규칙에 걸린 응답만 바꿔서 돌려준다."""

    def __init__(self, upstream: str, rules: list[Rule] | None = None) -> None:
        self.upstream = upstream
        self.rules = list(rules or [])
        self.seen: list[str] = []
        self.tampered: list[str] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("프록시가 아직 시작되지 않았다")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def _forward(self, body: bytes) -> bytes:
        request = urllib.request.Request(
            self.upstream,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=FORWARD_TIMEOUT_SEC) as response:
            return response.read()

    def _apply(self, request: dict, response: dict) -> dict:
        """하나의 JSON-RPC 쌍에 규칙을 적용한다."""
        method = request.get("method", "")
        self.seen.append(method)
        if "result" not in response:
            return response

        for rule in self.rules:
            if rule.method != method:
                continue
            response = {**response, "result": rule.apply(response["result"], request.get("params", []))}
            self.tampered.append(method)
        return response

    def handle(self, body: bytes) -> bytes:
        """ethers는 요청을 배열로 묶어 보내므로 단건과 배치를 모두 받는다."""
        requests = json.loads(body)
        responses = json.loads(self._forward(body))

        if isinstance(requests, list):
            by_id = {item.get("id"): item for item in requests}
            return json.dumps([self._apply(by_id.get(item.get("id"), {}), item) for item in responses]).encode()

        return json.dumps(self._apply(requests, responses)).encode()

    def start(self) -> "TamperingProxy":
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 — BaseHTTPRequestHandler의 규약
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                try:
                    payload = proxy.handle(body)
                except Exception as error:  # 업스트림 장애를 그대로 전달한다
                    payload = json.dumps({"error": {"code": -32603, "message": str(error)}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):  # 요청마다 stderr로 찍지 않는다
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self) -> "TamperingProxy":
        return self.start()

    def __exit__(self, *_) -> None:
        self.stop()


# --- 시나리오에서 쓰는 조작 ------------------------------------------------


def replace_field(index: int, value: object) -> Callable[[object, list], object]:
    """컨트랙트 조회 응답의 특정 항목을 바꾼다. eth_call 결과는 ABI 인코딩된 hex다."""

    def apply(result, _params):
        if not isinstance(result, str) or not result.startswith("0x"):
            return result
        body = result[2:]
        words = [body[offset : offset + 64] for offset in range(0, len(body), 64)]
        if index >= len(words):
            return result
        words[index] = format(int(value), "064x")
        return "0x" + "".join(words)

    return apply


def drop_results() -> Callable[[object, list], object]:
    """이벤트 로그처럼 목록으로 오는 응답을 비운다."""
    return lambda result, _params: [] if isinstance(result, list) else result


def patch_transaction_input(tx_hash: str, data: str) -> Callable[[object, list], object]:
    """블록 응답 안에서 해당 트랜잭션의 입력 데이터를 바꾼다."""

    def apply(result, _params):
        if not isinstance(result, dict) or not isinstance(result.get("transactions"), list):
            return result
        transactions = [
            {**tx, "input": data} if isinstance(tx, dict) and _same(tx.get("hash"), tx_hash) else tx
            for tx in result["transactions"]
        ]
        return {**result, "transactions": transactions}

    return apply


def drop_transaction(tx_hash: str) -> Callable[[object, list], object]:
    """블록의 트랜잭션 목록에서 해당 트랜잭션을 빼낸다."""

    def apply(result, _params):
        if not isinstance(result, dict) or not isinstance(result.get("transactions"), list):
            return result
        transactions = [
            tx for tx in result["transactions"] if not (isinstance(tx, dict) and _same(tx.get("hash"), tx_hash))
        ]
        return {**result, "transactions": transactions}

    return apply


def _same(left: object, right: object) -> bool:
    return isinstance(left, str) and isinstance(right, str) and left.lower() == right.lower()
