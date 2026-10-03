#!/usr/bin/env bash
# 홈서버 authorized_keys의 forced-command로만 실행되는 배포 스크립트.
# GitHub Actions가 보낸 커맨드 인자는 sshd가 무시하고 이 스크립트만 실행한다.
# 함수로 감싸고 맨 끝에서 한 번만 호출한다.
# git pull이 이 파일 자체를 덮어써도 이번 실행 로직에는 영향이 없다.

set -euo pipefail

main() {
  local sha="${SSH_ORIGINAL_COMMAND:-}"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "[ci-deploy] 40자리 커밋 SHA가 필요하다" >&2
    exit 1
  fi
  cd "${CI_DEPLOY_ROOT:-/home/homeserver/project/mediledger}"

  echo "[ci-deploy] $(date -Iseconds) start (sha requested: $sha)"

  # 코드/설정 동기화. 이미지는 여기서 빌드하지 않는다.
  # .env, blockchain/besu/.env, config/genesis.json, validators/*/data,
  # deployments/*.json 은 전부 gitignore 대상이라 아래 명령으로 건드려지지 않는다.
  git fetch origin main
  git cat-file -e "$sha^{commit}"
  git merge-base --is-ancestor "$sha" origin/main
  git merge-base --is-ancestor HEAD "$sha"

  export DEPLOY_IMAGE_TAG="sha-$sha"
  # 현재 체크아웃의 Compose 파일이 아직 최신이 아니어도 SHA 이미지를 확인한다.
  docker pull "ghcr.io/ihyonoo/mediledger-equiptrace-backend:$DEPLOY_IMAGE_TAG"
  docker pull "ghcr.io/ihyonoo/mediledger-equiptrace-web:$DEPLOY_IMAGE_TAG"
  docker pull "ghcr.io/ihyonoo/mediledger-equiptrace-simulator:$DEPLOY_IMAGE_TAG"

  # 요청된 커밋까지만 소스를 전진시킨다.
  git merge --ff-only "$sha"

  # backend/web/simulator만 재생성한다.
  # postgres/redis/cloudflared/besu는 --no-deps로 그대로 둔다.
  docker compose up -d --no-deps backend web simulator

  # 더 이상 참조되지 않는 옛 이미지 레이어를 정리한다.
  docker image prune -f

  echo "[ci-deploy] $(date -Iseconds) done"
}

main
