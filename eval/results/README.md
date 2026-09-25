# 측위 평가 결과

`python -m eval.positioning`으로 얻은 결과의 기록본이다. 트레이스(수 GB)는 시드로
다시 만들 수 있으므로 저장소에 두지 않고, 수치와 그 출처만 남긴다.

| 파일 | 내용 |
|---|---|
| `run.json` | 시드, 커밋 해시, 시뮬레이션 시작 시각, 전파 상수, 행 수 |
| `results_decisions.csv` | 1단계 판정 축 735조합 (24시간 구간) |
| `results_aggregations.csv` | 2단계 집계 축 240행 (09~12시 구간) |
| `integrity.csv` | 무결성 시나리오 17종 × 이력 10건의 판정 170행 (합의 실증 2종은 CSV에 담기지 않는다) |

한 행은 파라미터 7개와 지표 6개, 표본 수로 이루어진다. 두 단계는 구간이 다르므로
절대값을 서로 비교하지 않는다 — 1단계는 참값 전환 524건, 2단계는 124건 위에서 계산된다.

## 다시 만들기

```bash
python -m eval.positioning collect --hours 24 --raw-hours 3 --start 2026-09-21T09:00
python -m eval.positioning sweep
```

`run.json`의 시드와 커밋 해시가 같으면 같은 트레이스가 나온다. 수집 약 5분,
스윕 약 70분(9워커 기준)이 걸린다.

## 무결성

```bash
bash scripts/dev-up.sh            # 백엔드·DB·Besu가 모두 떠 있어야 한다
python -m eval.integrity --repeat 10 --consensus
```

`goal` 열이 공격 목적이다. **은폐**는 변조한 기록을 정상으로 통과시키려는 것이고,
**훼손**은 정상 기록을 변조된 것처럼 보이게 만들려는 것이다. 증거 보존이 목적인
시스템에서는 둘 다 공격이다.

한 행은 회차 하나의 시나리오 하나다. `run`이 회차이고, 회차마다 다른 장비와 직원을
써서 대여 구역과 이동 경로가 달라진다 — 한 이력에만 성립하는 우연을 걸러내기 위함이다. `expected`는 기대한 결론, `status`는 구현이 돌려준 판정
상태, `matched`는 둘이 맞는지다. 계층별 통과 여부(`db_matches_onchain`,
`db_matches_event`, `tx_input_matches_db`, `tx_sender_matches`,
`transactions_root_matches`)가 함께 실려 어느 계층이 잡았는지를 읽을 수 있다.

`--consensus`는 검증 노드를 실제로 내렸다 올리므로 2분쯤 걸린다. 결과는 화면에만
출력되고 CSV에는 담기지 않는다 — 판정이 아니라 성질의 실증이기 때문이다.

시뮬레이터가 돌고 있으면 같은 Postgres에서 경합이 나 결과가 흔들린다. 평가 중에는
내려 둔다.
