// 진행도바 타임라인. 장면마다 간지 + 단계들을 예상 시간대로 이어 붙여 순환 한 바퀴를 편다
// 재생기가 단계를 시작할 때마다 그 단계 구간으로 다시 맞춘다 — 로딩이 늦어도 오차가 쌓이지 않는다
import { type Scene, expectedStepMs } from './player';

export type Span = { start: number; ms: number };

export type Timeline = {
  totalMs: number;
  // 장면 하나의 구간(간지부터 마지막 단계까지) — 진행도바의 칸
  scenes: Span[];
  // stepIndex를 빼면 장면 첫머리 간지 구간
  span: (sceneIndex: number, stepIndex?: number) => Span;
};

// 앞으로 건너뛸 때 따라가는 빠르기 — 바 전체를 1.5초에
const CATCH_UP_PER_MS = 1 / 1_500;

export function createTimeline(scenes: Scene[], cardMs: number): Timeline {
  const cards: Span[] = [];
  const steps: Span[][] = [];
  const sceneSpans: Span[] = [];
  let at = 0;
  for (const scene of scenes) {
    const start = at;
    cards.push({ start, ms: cardMs });
    at += cardMs;
    steps.push(
      scene.steps.map((step) => {
        const span = { start: at, ms: expectedStepMs(step) };
        at += span.ms;
        return span;
      }),
    );
    sceneSpans.push({ start, ms: at - start });
  }
  return {
    totalMs: at,
    scenes: sceneSpans,
    span: (sceneIndex, stepIndex) => (stepIndex === undefined ? cards[sceneIndex] : steps[sceneIndex][stepIndex]),
  };
}

// 구간에 들어선 지 elapsedMs 지났을 때 한 바퀴 중 위치(0~1). 예상보다 길어지면 구간 끝에서 기다린다
export function progressAt(span: Span, elapsedMs: number, totalMs: number): number {
  return (span.start + Math.min(elapsedMs, span.ms)) / totalMs;
}

// 보이는 위치를 목표로 옮긴다 — 앞으로는 미끄러지듯 따라가고, 새 순환·앞 장면으로는 바로 맞춘다
export function approach(shown: number, target: number, dtMs: number): number {
  if (target <= shown) return target;
  return Math.min(target, shown + dtMs * CATCH_UP_PER_MS);
}

// 칸 하나가 찬 정도(0~1)
export function sectionFill(section: Span, atMs: number): number {
  return Math.min(1, Math.max(0, (atMs - section.start) / section.ms));
}
