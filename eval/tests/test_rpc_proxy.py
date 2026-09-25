"""조작 프록시가 응답을 실제로 바꾸는지 확인한다 — 체인 없이 가짜 업스트림으로 검증한다."""

import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from eval import rpc_proxy


class _Upstream:
    """정해둔 답만 돌려주는 가짜 RPC 노드."""

    def __init__(self, answers: dict):
        self.answers = answers
        self.calls: list[str] = []

    def start(self):
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                items = body if isinstance(body, list) else [body]
                out = []
                for item in items:
                    upstream.calls.append(item["method"])
                    out.append({"jsonrpc": "2.0", "id": item["id"], "result": upstream.answers[item["method"]]})
                payload = json.dumps(out if isinstance(body, list) else out[0]).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        host, port = self.server.server_address[:2]
        self.url = f"http://{host}:{port}"
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def call(url: str, method: str, params=None, request_id=1):
    body = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or []}).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


@pytest.fixture
def upstream():
    server = _Upstream(
        {
            "eth_call": "0x" + format(11, "064x") + format(22, "064x"),
            "eth_getLogs": [{"topics": ["0xabc"], "data": "0x01"}],
            "eth_getBlockByHash": {
                "transactionsRoot": "0xroot",
                "transactions": [
                    {"hash": "0xAA", "input": "0xdeadbeef"},
                    {"hash": "0xbb", "input": "0xfeedface"},
                ],
            },
        }
    ).start()
    yield server
    server.stop()


class TestForwarding:
    def test_without_rules_the_answer_passes_through(self, upstream):
        with rpc_proxy.TamperingProxy(upstream.url) as proxy:
            assert call(proxy.url, "eth_getLogs")["result"] == upstream.answers["eth_getLogs"]
            assert proxy.tampered == []
            assert proxy.seen == ["eth_getLogs"]

    def test_batched_requests_are_handled(self, upstream):
        with rpc_proxy.TamperingProxy(upstream.url, [rpc_proxy.Rule("eth_getLogs", rpc_proxy.drop_results())]) as proxy:
            body = json.dumps(
                [
                    {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": []},
                    {"jsonrpc": "2.0", "id": 2, "method": "eth_getLogs", "params": []},
                ]
            ).encode()
            request = urllib.request.Request(proxy.url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=5) as response:
                results = {item["id"]: item["result"] for item in json.loads(response.read())}

            # 배치 안에서도 규칙에 걸린 것만 바뀐다.
            assert results[1] == upstream.answers["eth_call"]
            assert results[2] == []
            assert proxy.tampered == ["eth_getLogs"]


class TestTampering:
    def test_a_contract_read_field_can_be_replaced(self, upstream):
        rules = [rpc_proxy.Rule("eth_call", rpc_proxy.replace_field(1, 99))]
        with rpc_proxy.TamperingProxy(upstream.url, rules) as proxy:
            result = call(proxy.url, "eth_call")["result"]

        assert int(result[2:66], 16) == 11, "건드리지 않은 항목은 그대로여야 한다"
        assert int(result[66:130], 16) == 99

    def test_event_logs_can_be_emptied(self, upstream):
        rules = [rpc_proxy.Rule("eth_getLogs", rpc_proxy.drop_results())]
        with rpc_proxy.TamperingProxy(upstream.url, rules) as proxy:
            assert call(proxy.url, "eth_getLogs")["result"] == []

    def test_a_transaction_input_can_be_rewritten(self, upstream):
        rules = [rpc_proxy.Rule("eth_getBlockByHash", rpc_proxy.patch_transaction_input("0xaa", "0xcafe"))]
        with rpc_proxy.TamperingProxy(upstream.url, rules) as proxy:
            block = call(proxy.url, "eth_getBlockByHash")["result"]

        # 해시 비교는 대소문자를 가리지 않고, 나머지 트랜잭션은 건드리지 않는다.
        assert block["transactions"][0]["input"] == "0xcafe"
        assert block["transactions"][1]["input"] == "0xfeedface"

    def test_a_transaction_can_be_removed_from_the_block(self, upstream):
        rules = [rpc_proxy.Rule("eth_getBlockByHash", rpc_proxy.drop_transaction("0xAA"))]
        with rpc_proxy.TamperingProxy(upstream.url, rules) as proxy:
            block = call(proxy.url, "eth_getBlockByHash")["result"]

        assert [tx["hash"] for tx in block["transactions"]] == ["0xbb"]

    def test_several_rules_apply_to_different_methods(self, upstream):
        rules = [
            rpc_proxy.Rule("eth_call", rpc_proxy.replace_field(0, 7)),
            rpc_proxy.Rule("eth_getLogs", rpc_proxy.drop_results()),
        ]
        with rpc_proxy.TamperingProxy(upstream.url, rules) as proxy:
            assert int(call(proxy.url, "eth_call")["result"][2:66], 16) == 7
            assert call(proxy.url, "eth_getLogs", request_id=2)["result"] == []
            assert proxy.tampered == ["eth_call", "eth_getLogs"]
