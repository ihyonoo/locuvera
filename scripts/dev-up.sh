#!/usr/bin/env bash
# 로컬 전면 가동: Docker Desktop → 인프라(postgres·redis·besu) → backend → frontend → simulator.
# 멱등: 이미 떠 있는 건 건드리지 않고 넘어간다.
# 로그는 .logs/backend.log / .logs/frontend.log / .logs/simulator.log (매 기동마다 새로 씀).
# 정지: bash scripts/dev-down.sh 는 없다 — 앱은 kill, 인프라는 docker-compose -f docker-compose.dev.yml down.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
mkdir -p "$ROOT/.logs"

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# 1) Docker 런타임(Docker Desktop)
if docker info >/dev/null 2>&1; then
  echo "[1/6] docker: 이미 실행 중"
else
  echo "[1/6] docker: Docker Desktop 시작"
  open -a Docker
  # 앱 실행과 데몬 기동 사이에 시차가 있다 — 소켓이 열릴 때까지 대기(최대 60초).
  for _ in $(seq 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  docker info >/dev/null 2>&1 || { echo "docker 데몬이 60초 안에 응답하지 않았다"; exit 1; }
fi

# 2) 인프라 — postgres + redis + besu(검증자 4 + RPC 노드)
echo "[2/6] 인프라: docker-compose -f docker-compose.dev.yml up -d"
docker-compose -f docker-compose.dev.yml up -d

# postgres가 접속을 받을 때까지 대기(최대 30초).
for _ in $(seq 30); do
  docker exec mediledger-postgres-dev pg_isready -U mediledger -q && break
  sleep 1
done

# 2.5) 스키마 + 시뮬레이션 시드
echo "[3/6] schema + seed: database/schema.sql, simulation.apply_seed"
psql "${DATABASE_URL:-postgresql://mediledger:mediledger@localhost:5432/mediledger_db}" \
  -q -f database/schema.sql
# 재시드하면 떠 있는 시뮬레이터의 월드 상태가 DB와 반드시 어긋나므로, 6단계가 새로 띄우도록 먼저 내린다.
pkill -f 'simulation\.simulator' 2>/dev/null || true
# 백엔드도 같이 내린다 — 위치 판정 상태(tag_state)가 프로세스 메모리에 있어서,
# apply_seed가 Redis를 비워도 백엔드는 "이미 그 리더에 있다"며 캐시를 다시 쓰지 않는다.
# 그러면 지도에 태그가 몇 개만 남는다(실측: 50개 중 5개).
pkill -f 'uvicorn backend.server' 2>/dev/null || true
"$ROOT/.venv/bin/python" -m simulation.apply_seed

# 3) backend — uvicorn --reload
if port_busy 8000; then
  echo "[4/6] backend: 이미 :8000 사용 중 — 건너뜀"
else
  echo "[4/6] backend: uvicorn :8000"
  nohup "$ROOT/.venv/bin/uvicorn" backend.server:app --reload --host 0.0.0.0 --port 8000 \
    >"$ROOT/.logs/backend.log" 2>&1 &
fi

# 4) frontend — vite dev
if port_busy 5173; then
  echo "[5/6] frontend: 이미 :5173 사용 중 — 건너뜀"
else
  echo "[5/6] frontend: vite :5173"
  (cd frontend && nohup npm run dev >"$ROOT/.logs/frontend.log" 2>&1 &)
fi

# 5) simulator — 가상 병원 상시 가동
if pgrep -f 'simulation\.simulator' >/dev/null 2>&1; then
  echo "[6/6] simulator: 이미 실행 중 — 건너뜀"
else
  echo "[6/6] simulator: python -m simulation.simulator"
  # -u: 리다이렉트 시 stdout이 버퍼링돼 로그가 비는 걸 막음.
  nohup "$ROOT/.venv/bin/python" -u -m simulation.simulator >"$ROOT/.logs/simulator.log" 2>&1 &
fi

echo
echo "backend  http://localhost:8000/docs"
echo "frontend http://localhost:5173"
echo "besu rpc http://127.0.0.1:8549"
