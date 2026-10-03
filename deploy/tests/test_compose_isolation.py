from pathlib import Path

import yaml

COMPOSE = Path(__file__).resolve().parents[2] / "docker-compose.yml"


def test_simulator_does_not_receive_besu_or_backend_secrets():
    services = yaml.safe_load(COMPOSE.read_text())["services"]
    simulator = services["simulator"]

    assert "env_file" not in simulator
    assert set(simulator["environment"]) <= {
        "BACKEND_BASE_URL",
        "SIM_STAFF_PASSWORD",
        "RTLS_SIM_KEY",
        "SIM_HTTP_TIMEOUT_SEC",
        "SIM_INGEST_TIMEOUT_SEC",
        "RETURN_HTTP_TIMEOUT_SEC",
        "SIM_RANDOM_SEED",
    }
    assert simulator["networks"] == ["simulator-api"]
    assert "simulator-api" in services["backend"]["networks"]
