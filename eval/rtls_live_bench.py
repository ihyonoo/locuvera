"""/rtls/live 성능 평가 — 이력 규모에 따라 세 구성의 응답 시간이 어떻게 변하는지 잰다.

① 이력 전체 스캔(DB만), ② 인덱스 조회(DB만), ③ 인덱스 조회 + Redis.
①은 변경 전 커밋, ②·③은 변경 후 커밋이며 ①·②는 Redis를 끈다. 그래서 ①→②가 쿼리
개선의 몫, ②→③이 Redis의 몫이다. 각 커밋을 배포용 backend/Dockerfile로 빌드해 개발
Postgres·Redis와 같은 Docker 네트워크에서 띄우고, 같은 벤치 전용 DB 위에서 번갈아 잰다.

백엔드를 호스트에서 띄우면 요청마다 새로 맺는 DB 연결(요청당 약 5개)이 Docker Desktop의
포트 포워딩을 거치는데, 초당 수백 개가 30초쯤 쌓이면 프록시가 연결을 거부한다.
컨테이너끼리는 프록시를 거치지 않고, 이 배치가 홈서버 배포와도 같다.

개발 DB(mediledger_db)와 개발 Redis(/0)는 건드리지 않는다 — 가드가 URL을 확인한다.
절차와 근거는 docs/design/2026-09-30-rtls-live-benchmark.md.
"""

import asyncio
import csv
import datetime as dt
import json
import os
import platform
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[1]
RUN_DIR = ROOT / "eval" / "runs" / "bench"

DOCKER_NETWORK = "mediledger-dev_default"
CONTAINER = "locuvera-bench-backend"
BENCH_DB = "mediledger_bench_db"
BENCH_REDIS_DB = 2
AUTH_SECRET = "bench-secret"
PORT = 8101

TAG_COUNT = 50
READER_COUNT = 20
DEFAULT_SIZES = [10_000, 100_000, 1_000_000, 10_000_000]
DEFAULT_CLIENTS = [1, 10, 50]

POLL_SEC = 60
THROUGHPUT_SEC = 30
WARMUP_SEC = 5
TIMEOUT_SEC = 30
# 브라우저의 호스트당 HTTP/1.1 동시 연결 한도
BROWSER_CONNECTIONS = 6

# 셀 사이 안정화 대기. 변경 전 셀의 무거운 스캔과 이력 삽입 뒤 체크포인트가 다음 셀을 오염시켰다.
SETTLE_SEC = 20

HANDLER_MAX_CALLS = 200
HANDLER_MAX_SEC = 60
HANDLER_MIN_CALLS = 5

# (이름, 커밋 역할, Redis 사용)
CONFIGS = (
    ("scan_db", "before", False),
    ("indexed_db", "after", False),
    ("indexed_redis", "after", True),
)
# 컨테이너 안에서 즉시 연결이 거부되는 주소 — 연결 대기 시간이 측정에 섞이지 않는다
REDIS_OFF_NETLOC = "127.0.0.1:1"

FIELDS = [
    "config",
    "commit",
    "size",
    "mode",
    "clients",
    "sent",
    "completed",
    "errors",
    "p50",
    "p95",
    "max",
    "mean",
    "rps",
]


# ---------- 순수 함수 ----------


def percentile(values: list[float], q: float) -> float:
    """선형 보간 백분위수 (numpy 기본값과 같다)."""
    ordered = sorted(values)
    rank = (len(ordered) - 1) * q / 100
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def summarize(latencies_ms: list[float]) -> dict:
    if not latencies_ms:
        return {"p50": None, "p95": None, "max": None, "mean": None}
    return {
        "p50": percentile(latencies_ms, 50),
        "p95": percentile(latencies_ms, 95),
        "max": max(latencies_ms),
        "mean": sum(latencies_ms) / len(latencies_ms),
    }


def growth_plan(sizes: list[int]) -> list[tuple[int, int]]:
    """규모 단계를 (이미 있는 행 수, 목표 행 수)로 바꾼다. 단계마다 차이만 넣는다."""
    ordered = sorted(sizes)
    if len(set(ordered)) != len(ordered):
        raise ValueError(f"중복된 규모: {sizes}")
    return list(zip([0, *ordered[:-1]], ordered, strict=True))


def polling_offsets(clients: int) -> list[float]:
    """클라이언트 시작 시점을 1초 안에 고르게 흩뿌린다. 한꺼번에 쏘면 매초 몰림이 생긴다."""
    return [index / clients for index in range(clients)]


def assert_bench_urls(db_url: str, redis_url: str) -> None:
    db_name = urlparse(db_url).path.lstrip("/")
    redis_db = urlparse(redis_url).path.lstrip("/")
    if db_name != BENCH_DB or redis_db != str(BENCH_REDIS_DB):
        raise SystemExit(f"벤치 전용 DB·Redis가 아니다: {db_name!r}, redis db {redis_db!r}")


# ---------- 환경 ----------


def bench_urls() -> tuple[str, str]:
    from dotenv import dotenv_values

    env = {**dotenv_values(ROOT / ".env"), **os.environ}
    db = urlparse(env.get("DATABASE_URL", "postgresql://mediledger:mediledger@localhost:5432/mediledger_db"))
    redis = urlparse(env.get("REDIS_URL", "redis://127.0.0.1:6379/0"))
    db_url = urlunparse(db._replace(path=f"/{BENCH_DB}"))
    redis_url = urlunparse(redis._replace(path=f"/{BENCH_REDIS_DB}"))
    assert_bench_urls(db_url, redis_url)
    return db_url, redis_url


def container_urls(db_url: str, redis_url: str) -> tuple[str, str]:
    """호스트용 URL을 compose 서비스 이름으로 바꾼다. 컨테이너는 프록시 없이 직접 붙는다."""
    db = urlparse(db_url)
    credentials = db.netloc.rsplit("@", 1)[0] + "@" if "@" in db.netloc else ""
    return (
        urlunparse(db._replace(netloc=f"{credentials}postgres:5432")),
        urlunparse(urlparse(redis_url)._replace(netloc="redis:6379")),
    )


def container_env(db_url: str, redis_url: str, *, redis: bool) -> list[str]:
    in_db, in_redis = container_urls(db_url, redis_url)
    if not redis:
        in_redis = urlunparse(urlparse(in_redis)._replace(netloc=REDIS_OFF_NETLOC))
    env = {
        "DATABASE_URL": in_db,
        "REDIS_URL": in_redis,
        "AUTH_TOKEN_SECRET": AUTH_SECRET,
        # 실물 NFC 검증은 측정 대상이 아니다 — 기동마다 뜨는 키 누락 경고만 막는다
        "NTAG_MASTER_KEY": "00" * 16,
        "BENCH_REDIS": "1" if redis else "0",
    }
    return [flag for key, value in env.items() for flag in ("-e", f"{key}={value}")]


def build_image(commit: str) -> str:
    """그 커밋의 트리를 배포용 Dockerfile로 빌드한다."""
    tag = f"{CONTAINER}:{commit}"
    archive = subprocess.run(["git", "archive", commit], cwd=ROOT, check=True, capture_output=True).stdout
    subprocess.run(
        ["docker", "build", "-q", "-f", "backend/Dockerfile", "-t", tag, "-"],
        input=archive,
        check=True,
        capture_output=True,
    )
    return tag


def version_python(image: str, env_flags: list[str], code: str, extra_env: dict | None = None) -> str:
    """그 버전 이미지 안에서 파이썬 코드를 돌린다."""
    extra = [flag for key, value in (extra_env or {}).items() for flag in ("-e", f"{key}={value}")]
    result = subprocess.run(
        ["docker", "run", "--rm", "--network", DOCKER_NETWORK, *env_flags, *extra, image, "python", "-c", code],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


# ---------- 데이터 ----------


def recreate_db(db_url: str) -> None:
    import psycopg

    admin_url = urlunparse(urlparse(db_url)._replace(path="/postgres"))
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {BENCH_DB} WITH (FORCE)")
        conn.execute(f"CREATE DATABASE {BENCH_DB}")
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute((ROOT / "database" / "schema.sql").read_text())
        conn.execute(
            """
            INSERT INTO readers (reader_id, location_name)
            SELECT 'B' || lpad(i::text, 3, '0'), '벤치 구역 ' || i FROM generate_series(1, %s) i
            """,
            (READER_COUNT,),
        )
        conn.execute(
            """
            INSERT INTO tags (tag_id, equipment_name, is_active)
            SELECT 'bench:2:' || lpad(i::text, 3, '0'), '벤치장비-' || lpad(i::text, 3, '0'), TRUE
            FROM generate_series(1, %s) i
            """,
            (TAG_COUNT,),
        )
        conn.execute(
            """
            INSERT INTO users (username, display_name, role, position, password_hash)
            VALUES ('bench', 'bench', 'staff', 'bench', 'x')
            """
        )


def grow_history(db_url: str, start: int, target: int) -> float:
    import psycopg

    began = time.perf_counter()
    with psycopg.connect(db_url, autocommit=True) as conn:
        # 행 g는 태그 1 + g%50에 속하고 decided_at이 g초 — 단계를 넘어도 태그별로 단조 증가한다.
        conn.execute(
            """
            INSERT INTO tag_state_history (tag_id, reader_id, rssi, decided_at)
            SELECT 'bench:2:' || lpad((1 + g %% %(tags)s)::text, 3, '0'),
                   'B' || lpad((1 + (7 * g) %% %(readers)s)::text, 3, '0'),
                   -60,
                   timestamptz '2025-01-01' + g * interval '1 second'
            FROM generate_series(%(start)s + 1, %(target)s) g
            """,
            {"tags": TAG_COUNT, "readers": READER_COUNT, "start": start, "target": target},
        )
        conn.execute("VACUUM ANALYZE tag_state_history")
    return time.perf_counter() - began


def terminate_other_sessions(db_url: str) -> None:
    """앞 셀에서 아직 도는 전체 스캔이 다음 셀로 새지 않게 끊는다."""
    import psycopg

    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s AND pid <> pg_backend_pid()",
            (BENCH_DB,),
        )


def settle(db_url: str) -> None:
    """앞 작업의 여파가 가라앉게 한다 — 남은 세션을 끊고, 밀린 쓰기를 동기로 내리고, 잠시 쉰다."""
    import psycopg

    terminate_other_sessions(db_url)
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute("CHECKPOINT")
    time.sleep(SETTLE_SEC)


def flush_cache(redis_url: str) -> None:
    import redis

    redis.Redis.from_url(redis_url).flushdb()


def cached_location_keys(redis_url: str) -> int:
    import redis

    return sum(1 for _ in redis.Redis.from_url(redis_url).scan_iter(match="rtls:tag:*:current"))


# ---------- 서버 ----------


class Server:
    def __init__(self, image: str, env_flags: list[str]):
        self.image = image
        self.env_flags = env_flags
        self.base = f"http://127.0.0.1:{PORT}"

    def __enter__(self):
        import httpx

        self._remove()
        subprocess.run(
            [
                "docker", "run", "-d", "--rm", "--name", CONTAINER, "--network", DOCKER_NETWORK,
                "-p", f"{PORT}:8000", *self.env_flags, self.image,
                "uvicorn", "backend.server:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "warning",
            ],
            check=True,
            capture_output=True,
        )  # fmt: skip
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                if httpx.get(f"{self.base}/openapi.json", timeout=1).status_code == 200:
                    return self
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        self._remove()
        raise RuntimeError("서버 컨테이너가 30초 안에 뜨지 않았다")

    def __exit__(self, *_):
        self._remove()

    @staticmethod
    def _remove():
        subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)


# ---------- 측정 ----------


async def _request(client, url: str, headers: dict, t0: float) -> tuple[float, float, float, bool]:
    import httpx

    sent = time.perf_counter()
    try:
        ok = (await client.get(url, headers=headers)).status_code == 200
    except httpx.HTTPError:
        ok = False
    done = time.perf_counter()
    return sent - t0, done - t0, (done - sent) * 1000, ok


async def _polling_client(url, headers, offset, t0) -> list:
    import httpx

    limits = httpx.Limits(max_connections=BROWSER_CONNECTIONS)
    async with httpx.AsyncClient(limits=limits, timeout=TIMEOUT_SEC) as client:
        tasks = []
        tick = 0
        # 프론트엔드의 setInterval처럼 응답을 기다리지 않고 1초마다 쏜다.
        while offset + tick < POLL_SEC:
            await asyncio.sleep(max(0.0, t0 + offset + tick - time.perf_counter()))
            tasks.append(asyncio.create_task(_request(client, url, headers, t0)))
            tick += 1
        return await asyncio.gather(*tasks)


async def _throughput_client(url, headers, t0) -> list:
    import httpx

    async with httpx.AsyncClient(timeout=TIMEOUT_SEC) as client:
        results = []
        while time.perf_counter() - t0 < THROUGHPUT_SEC:
            results.append(await _request(client, url, headers, t0))
        return results


def measure_http(mode: str, base: str, token: str, clients: int) -> dict:
    url = f"{base}/rtls/live"
    headers = {"Authorization": f"Bearer {token}"}

    async def run():
        t0 = time.perf_counter()
        if mode == "polling":
            jobs = [_polling_client(url, headers, offset, t0) for offset in polling_offsets(clients)]
        else:
            jobs = [_throughput_client(url, headers, t0) for _ in range(clients)]
        return [row for rows in await asyncio.gather(*jobs) for row in rows]

    samples = [row for row in asyncio.run(run()) if row[0] >= WARMUP_SEC]
    latencies = [ms for _, _, ms, ok in samples if ok]
    row = {
        "sent": len(samples),
        "completed": len(latencies),
        "errors": len(samples) - len(latencies),
        **summarize(latencies),
        "rps": None,
    }
    if mode == "throughput":
        in_window = sum(1 for _, done, _, ok in samples if ok and done <= THROUGHPUT_SEC)
        row["rps"] = in_window / (THROUGHPUT_SEC - WARMUP_SEC)
    return row


def warm_up(base: str, token: str, redis_url: str, *, redis: bool) -> None:
    import httpx

    response = httpx.get(f"{base}/rtls/live", headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT_SEC * 2)
    response.raise_for_status()
    if redis and (keys := cached_location_keys(redis_url)) != TAG_COUNT:
        raise RuntimeError(f"워밍업 후 캐시 키 {keys}개, {TAG_COUNT}개여야 한다")


HANDLER_CODE = f"""
import json, os, time
import backend.server as server
from backend.rtls_utils import get_redis_client

auth = "Bearer " + os.environ["BENCH_TOKEN"]
server.rtls_live(authorization=auth, hide_simulated=False)
if os.environ["BENCH_REDIS"] == "1":
    keys = sum(1 for _ in get_redis_client().scan_iter(match="rtls:tag:*:current"))
    assert keys == {TAG_COUNT}, keys

times = []
began = time.perf_counter()
while len(times) < {HANDLER_MAX_CALLS} and (
    time.perf_counter() - began < {HANDLER_MAX_SEC} or len(times) < {HANDLER_MIN_CALLS}
):
    start = time.perf_counter()
    server.rtls_live(authorization=auth, hide_simulated=False)
    times.append((time.perf_counter() - start) * 1000)
print(json.dumps(times))
"""


def measure_handler(image: str, env_flags: list[str], token: str) -> dict:
    times = json.loads(version_python(image, env_flags, HANDLER_CODE, {"BENCH_TOKEN": token}))
    kept = times[len(times) // 10 :]
    return {"sent": len(kept), "completed": len(kept), "errors": 0, **summarize(kept), "rps": None}


# ---------- 실행 ----------


def machine_info(db_url: str, redis_url: str) -> dict:
    import psycopg
    import redis

    def sysctl(key):
        try:
            return subprocess.run(["sysctl", "-n", key], capture_output=True, text=True).stdout.strip()
        except OSError:
            return ""

    with psycopg.connect(db_url) as conn:
        postgres = conn.execute("SHOW server_version").fetchone()[0]
    memsize = sysctl("hw.memsize")
    docker = subprocess.run(
        ["docker", "info", "--format", "{{.NCPU}} {{.MemTotal}}"], capture_output=True, text=True
    ).stdout.split()
    return {
        "cpu": sysctl("machdep.cpu.brand_string") or platform.processor(),
        "ram_gb": round(int(memsize) / 2**30) if memsize.isdigit() else None,
        "os": platform.platform(),
        "docker_cpus": int(docker[0]) if docker else None,
        "docker_mem_gb": round(int(docker[1]) / 2**30, 1) if docker else None,
        "postgres": postgres,
        "redis": redis.Redis.from_url(redis_url).info("server")["redis_version"],
    }


def run(before: str, after: str, sizes: list[int], clients: list[int], out_dir: Path = RUN_DIR) -> Path:
    db_url, redis_url = bench_urls()
    versions = {
        "before": subprocess.run(
            ["git", "rev-parse", "--short", before], cwd=ROOT, check=True, capture_output=True, text=True
        ).stdout.strip(),
        "after": subprocess.run(
            ["git", "rev-parse", "--short", after], cwd=ROOT, check=True, capture_output=True, text=True
        ).stdout.strip(),
    }
    print("이미지 빌드", flush=True)
    images = {name: build_image(commit) for name, commit in versions.items()}
    env_on = container_env(db_url, redis_url, redis=True)

    out_dir.mkdir(parents=True, exist_ok=True)
    out_csv = out_dir / "results.csv"
    meta = {
        "started_at": dt.datetime.now().isoformat(timespec="seconds"),
        "commits": versions,
        "configs": [{"name": name, "commit": versions[role], "redis": redis} for name, role, redis in CONFIGS],
        "sizes": sorted(sizes),
        "clients": clients,
        "tags": TAG_COUNT,
        "readers": READER_COUNT,
        "poll_sec": POLL_SEC,
        "throughput_sec": THROUGHPUT_SEC,
        "warmup_sec": WARMUP_SEC,
        "timeout_sec": TIMEOUT_SEC,
        "settle_sec": SETTLE_SEC,
        "build_sec": {},
    }

    print(f"벤치 DB 재생성: {BENCH_DB}", flush=True)
    recreate_db(db_url)
    meta["machine"] = machine_info(db_url, redis_url)
    token = version_python(
        images["after"],
        env_on,
        "import os\n"
        "from backend.auth_utils import build_auth_token\n"
        "import psycopg\n"
        "uid = psycopg.connect(os.environ['DATABASE_URL']).execute("
        "\"SELECT user_id FROM users WHERE username = 'bench'\").fetchone()[0]\n"
        "print(build_auth_token(user_id=uid)[0])",
    )

    with out_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for start, target in growth_plan(sizes):
            print(f"이력 {start:,} → {target:,}행", end="", flush=True)
            meta["build_sec"][target] = round(grow_history(db_url, start, target), 1)
            print(f" ({meta['build_sec'][target]}초)", flush=True)

            for name, role, redis in CONFIGS:
                env_flags = container_env(db_url, redis_url, redis=redis)
                cells = [("handler", 1)] + [(mode, n) for mode in ("polling", "throughput") for n in clients]
                for mode, n in cells:
                    settle(db_url)
                    flush_cache(redis_url)
                    if mode == "handler":
                        result = measure_handler(images[role], env_flags, token)
                    else:
                        with Server(images[role], env_flags) as server:
                            warm_up(server.base, token, redis_url, redis=redis)
                            result = measure_http(mode, server.base, token, n)
                    row = {"config": name, "commit": versions[role], "size": target, "mode": mode, "clients": n}
                    row.update(result)
                    writer.writerow(row)
                    handle.flush()
                    p95 = f"{result['p95']:.1f}ms" if result["p95"] is not None else "-"
                    rps = f" {result['rps']:.1f}req/s" if result["rps"] is not None else ""
                    print(
                        f"  {name:<13} {mode:<10} N={n:<3} p95 {p95}{rps} "
                        f"({result['completed']}/{result['sent']}, 오류 {result['errors']})",
                        flush=True,
                    )

    terminate_other_sessions(db_url)
    meta["finished_at"] = dt.datetime.now().isoformat(timespec="seconds")
    (out_dir / "run.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    return out_csv


def plot(csv_path: Path) -> Path:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    with csv_path.open(encoding="utf-8") as handle:
        rows = [row for row in csv.DictReader(handle) if row["mode"] == "polling" and row["p95"]]

    plt.rcParams["font.family"] = ["AppleGothic", "sans-serif"]
    fig, ax = plt.subplots(figsize=(7, 4.5))
    styles = {
        "scan_db": ("#c0392b", "① 이력 전체 스캔 (DB만)"),
        "indexed_db": ("#d68910", "② 인덱스 조회 (DB만)"),
        "indexed_redis": ("#2471a3", "③ 인덱스 조회 + Redis"),
    }
    for name, (color, label) in styles.items():
        for n, marker in ((1, "o"), (10, "s")):
            points = sorted(
                (int(row["size"]), float(row["p95"]))
                for row in rows
                if row["config"] == name and int(row["clients"]) == n
            )
            if points:
                ax.plot(*zip(*points, strict=True), marker=marker, color=color, label=f"{label}, 동시 {n}명")
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel("tag_state_history 행 수")
    ax.set_ylabel("/rtls/live p95 응답 시간 (ms)")
    ax.set_title("1초 폴링 조건의 응답 시간")
    ax.grid(True, which="both", alpha=0.3)
    ax.legend(fontsize=8)
    fig.tight_layout()
    out = csv_path.with_name("rtls_live_bench.png")
    fig.savefig(out, dpi=150)
    plot_redis(csv_path)
    return out


def plot_redis(csv_path: Path) -> Path:
    """②·③만 일반 축 막대로 비교한다. 로그 축 그래프에서는 Redis의 몫이 눈에 띄지 않는다."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    with csv_path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    def values(config, mode, clients, key):
        cells = sorted(
            (int(row["size"]), float(row[key]))
            for row in rows
            if row["config"] == config and row["mode"] == mode and int(row["clients"]) == clients
        )
        return [size for size, _ in cells], [value for _, value in cells]

    plt.rcParams["font.family"] = ["AppleGothic", "sans-serif"]
    fig, (left, right) = plt.subplots(1, 2, figsize=(10, 4.2))
    panels = (
        (left, "handler", 1, "p95", "핸들러 p95 응답 시간 (ms)", "{:.1f}"),
        (right, "throughput", 10, "rps", "최대 처리량, 동시 10명 (req/s)", "{:.0f}"),
    )
    bars = (("indexed_db", "#d68910", "② 인덱스 조회 (DB만)"), ("indexed_redis", "#2471a3", "③ 인덱스 조회 + Redis"))
    width = 0.38
    for ax, mode, clients, key, title, fmt in panels:
        for offset, (config, color, label) in zip((-width / 2, width / 2), bars, strict=True):
            sizes, ys = values(config, mode, clients, key)
            xs = [index + offset for index in range(len(sizes))]
            drawn = ax.bar(xs, ys, width, color=color, label=label)
            ax.bar_label(drawn, labels=[fmt.format(y) for y in ys], fontsize=7, padding=2)
        ax.set_xticks(range(len(sizes)), [f"{size:,}" for size in sizes])
        ax.set_xlabel("tag_state_history 행 수")
        ax.set_title(title)
        ax.grid(True, axis="y", alpha=0.3)
        ax.margins(y=0.15)
    left.legend(fontsize=8, loc="lower right")
    fig.suptitle("쿼리 개선 이후 Redis 도입 효과")
    fig.tight_layout()
    out = csv_path.with_name("rtls_live_bench_redis.png")
    fig.savefig(out, dpi=150)
    return out


def main(argv: list[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m eval.rtls_live_bench", description="/rtls/live 쿼리·캐시 구성별 성능 평가"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    run_cmd = commands.add_parser("run")
    run_cmd.add_argument("--before", default="aa53d61")
    run_cmd.add_argument("--after", default="ded8e05")
    run_cmd.add_argument("--sizes", type=int, nargs="+", default=DEFAULT_SIZES)
    run_cmd.add_argument("--clients", type=int, nargs="+", default=DEFAULT_CLIENTS)
    plot_cmd = commands.add_parser("plot")
    plot_cmd.add_argument("csv", type=Path, nargs="?", default=RUN_DIR / "results.csv")
    args = parser.parse_args(argv)

    if args.command == "run":
        print(run(args.before, args.after, args.sizes, args.clients))
    else:
        print(plot(args.csv))


if __name__ == "__main__":
    main()
