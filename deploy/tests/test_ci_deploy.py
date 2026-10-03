import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "ci-deploy.sh"
SHA = "a" * 40


def _run_deploy(tmp_path, original_command, *, pull_fails=False):
    command_dir = tmp_path / "bin"
    command_dir.mkdir()
    log = tmp_path / "commands.log"
    for name in ("git", "docker"):
        executable = command_dir / name
        failure = (
            f'[ "$1 $2" = "pull ghcr.io/ihyonoo/mediledger-equiptrace-web:sha-{SHA}" ] && exit 1\n'
            if name == "docker" and pull_fails
            else ""
        )
        executable.write_text(
            f'#!/bin/sh\nprintf "{name} %s | %s\\n" "$*" "${{DEPLOY_IMAGE_TAG:-}}" >> "{log}"\n' + failure
        )
        executable.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{command_dir}:{os.environ['PATH']}",
        "CI_DEPLOY_ROOT": str(tmp_path),
        "SSH_ORIGINAL_COMMAND": original_command,
    }
    result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
    return result, log.read_text().splitlines() if log.exists() else []


def test_deploy_pins_all_services_to_requested_commit_before_moving_source(tmp_path):
    result, commands = _run_deploy(tmp_path, SHA)

    assert result.returncode == 0, result.stderr
    pulls = [line for line in commands if line.startswith("docker pull")]
    assert pulls == [
        f"docker pull ghcr.io/ihyonoo/mediledger-equiptrace-backend:sha-{SHA} | sha-{SHA}",
        f"docker pull ghcr.io/ihyonoo/mediledger-equiptrace-web:sha-{SHA} | sha-{SHA}",
        f"docker pull ghcr.io/ihyonoo/mediledger-equiptrace-simulator:sha-{SHA} | sha-{SHA}",
    ]
    merge_index = next(i for i, line in enumerate(commands) if line.startswith("git merge --ff-only"))
    assert commands.index(pulls[0]) < merge_index
    assert f"git merge --ff-only {SHA} | sha-{SHA}" in commands
    assert f"docker compose up -d --no-deps backend web simulator | sha-{SHA}" in commands


def test_deploy_rejects_non_sha_command_without_touching_source_or_images(tmp_path):
    result, commands = _run_deploy(tmp_path, "main")

    assert result.returncode != 0
    assert commands == []


def test_deploy_does_not_move_source_when_any_image_is_missing(tmp_path):
    result, commands = _run_deploy(tmp_path, SHA, pull_fails=True)

    assert result.returncode != 0
    assert any(line.startswith("docker pull") for line in commands)
    assert not any(line.startswith("git merge --ff-only") for line in commands)
    assert not any(line.startswith("docker compose up") for line in commands)
