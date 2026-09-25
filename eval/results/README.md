# 측위 평가 결과

`python -m eval.positioning`으로 얻은 결과의 기록본이다. 트레이스(수 GB)는 시드로
다시 만들 수 있으므로 저장소에 두지 않고, 수치와 그 출처만 남긴다.

| 파일 | 내용 |
|---|---|
| `run.json` | 시드, 커밋 해시, 시뮬레이션 시작 시각, 전파 상수, 행 수 |
| `results_decisions.csv` | 1단계 판정 축 735조합 (24시간 구간) |
| `results_aggregations.csv` | 2단계 집계 축 240행 (09~12시 구간) |

한 행은 파라미터 7개와 지표 6개, 표본 수로 이루어진다. 두 단계는 구간이 다르므로
절대값을 서로 비교하지 않는다 — 1단계는 참값 전환 524건, 2단계는 124건 위에서 계산된다.

## 다시 만들기

```bash
python -m eval.positioning collect --hours 24 --raw-hours 3 --start 2026-09-21T09:00
python -m eval.positioning sweep
```

`run.json`의 시드와 커밋 해시가 같으면 같은 트레이스가 나온다. 수집 약 5분,
스윕 약 70분(9워커 기준)이 걸린다.
