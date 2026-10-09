import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "docker-compose.yml"
NGINX_CONF = ROOT / "deploy" / "nginx.conf"


def _compose():
    return yaml.safe_load(COMPOSE.read_text())


def test_backend_does_not_publish_host_ports():
    backend = _compose()["services"]["backend"]

    assert "ports" not in backend, f"backend가 호스트 포트를 게시함: {backend.get('ports')}"


def test_compose_does_not_require_external_networks():
    networks = _compose().get("networks", {})

    external = [name for name, spec in networks.items() if (spec or {}).get("external")]
    assert external == [], f"빈 서버에 없는 외부 네트워크에 의존함: {external}"


def test_nginx_proxies_only_to_root_compose_services():
    services = set(_compose()["services"])
    hosts = set(re.findall(r"proxy_pass\s+https?://([^:/;\s]+)", NGINX_CONF.read_text()))

    assert hosts, "nginx.conf에서 proxy_pass를 찾지 못함"
    assert hosts <= services, f"compose에 없는 upstream: {sorted(hosts - services)}"
