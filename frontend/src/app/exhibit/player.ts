// 전시 대본 재생기. 장면을 차례로 돌고 마지막 다음에는 처음으로 돌아간다
// signal이 끊기면(사람 개입) 하던 단계에서 바로 멈춘다
import { type Target, TargetNotFoundError, scrollTargetBy, setInputValue, waitForTarget } from './dom';

export type { Target } from './dom';
export type DemoRole = 'staff' | 'admin';

export type Step =
  | { do: 'go'; to: string }
  | { do: 'click'; target: Target; optional?: boolean }
  | { do: 'type'; target: Target; text: string }
  // 누르지 않고 커서만 옮겨 보여 준다(화면 밖이면 스크롤)
  | { do: 'point'; target: Target; optional?: boolean }
  | { do: 'scroll'; target: Target; by: number }
  | { do: 'wait'; ms: number }
  // 화면에 아무것도 하지 않고 대상이 그려질 때까지만 기다린다(간지 뒤에서 로딩을 가린다)
  | { do: 'ready'; target: Target }
  // 화면 아래 자막
  | { do: 'caption'; text: string };

export type Scene = {
  id: string;
  title: string;
  // 화면에 들어갈 데모 권한. 클립만 트는 장면은 없다
  role?: DemoRole;
  steps: Step[];
};

export type PlayerDeps = {
  navigate: (to: string) => void | Promise<void>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pointAt: (el: HTMLElement, signal: AbortSignal) => Promise<void>;
  beforeScene?: (scene: Scene, signal: AbortSignal) => Promise<void>;
  // 장면 첫머리 간지(번호·제목). 세션 전환과 첫 이동은 그 뒤에서 일어난다
  sceneStart?: (index: number, scene: Scene, signal: AbortSignal) => Promise<void>;
  caption?: (text: string, signal: AbortSignal) => void | Promise<void>;
  // 누르기 직전 커서가 눌리는 효과
  press?: (signal: AbortSignal) => Promise<void>;
  waitForTarget?: (target: Target, signal: AbortSignal, timeoutMs: number) => Promise<HTMLElement>;
  onScene?: (index: number, scene: Scene) => void;
  // 단계를 시작하기 직전 — 진행도바가 이 단계 구간으로 다시 맞춘다
  onStep?: (sceneIndex: number, stepIndex: number) => void;
};

// 화면이 데이터를 받아 그릴 때까지 기다리는 한도
const TARGET_TIMEOUT_MS = 15_000;
// 없을 수도 있는 대상은 짧게만 기다린다
const OPTIONAL_TARGET_TIMEOUT_MS = 3_000;
export const CLICK_PAUSE_MS = 600;
// 글자 사이 간격은 사람처럼 조금씩 다르게
const TYPE_KEY_MS = 70;
const TYPE_KEY_JITTER_MS = 50;
const SCROLL_PAUSE_MS = 900;
// 장면이 실패하면 잠깐 쉬고 다음 장면으로 — 모든 장면이 곧바로 실패해도 브라우저를 붙잡지 않게
const FAILED_SCENE_PAUSE_MS = 3_000;

// 진행도바용 단계별 예상 시간. 실제로는 화면 로딩·커서 거리에 따라 다르다
// 스크롤 정착 + 커서 이동 평균(ExhibitOverlay의 pointAt)
const EXPECTED_POINT_MS = 900;
// 누름 효과(ExhibitOverlay의 PRESS_MS)
const EXPECTED_PRESS_MS = 150;
// 화면이 데이터를 받아 그리는 평균
const EXPECTED_READY_MS = 600;

export function expectedStepMs(step: Step): number {
  switch (step.do) {
    case 'wait':
      return step.ms;
    case 'ready':
      return EXPECTED_READY_MS;
    case 'point':
      return EXPECTED_POINT_MS;
    case 'click':
      return EXPECTED_POINT_MS + EXPECTED_PRESS_MS + CLICK_PAUSE_MS;
    case 'type':
      return EXPECTED_POINT_MS + step.text.length * (TYPE_KEY_MS + TYPE_KEY_JITTER_MS / 2);
    case 'scroll':
      return SCROLL_PAUSE_MS;
    case 'go':
    case 'caption':
      return 0;
  }
}

export async function runExhibit(
  scenes: Scene[],
  startAt: number,
  signal: AbortSignal,
  deps: PlayerDeps,
): Promise<void> {
  if (scenes.length === 0) return;
  const find = deps.waitForTarget ?? waitForTarget;

  // 선택 대상이 없으면 null — 그 단계만 건너뛴다
  const locate = async (target: Target, optional = false): Promise<HTMLElement | null> => {
    try {
      return await find(target, signal, optional ? OPTIONAL_TARGET_TIMEOUT_MS : TARGET_TIMEOUT_MS);
    } catch (error) {
      if (optional && error instanceof TargetNotFoundError) return null;
      throw error;
    }
  };

  const runStep = async (step: Step) => {
    switch (step.do) {
      case 'go':
        await deps.navigate(step.to);
        return;
      case 'wait':
        await deps.sleep(step.ms, signal);
        return;
      case 'caption':
        await deps.caption?.(step.text, signal);
        return;
      case 'ready':
        await locate(step.target);
        return;
      case 'click': {
        const el = await locate(step.target, step.optional);
        if (!el) return;
        await deps.pointAt(el, signal);
        await deps.press?.(signal);
        if (signal.aborted) return;
        el.click();
        await deps.sleep(CLICK_PAUSE_MS, signal);
        return;
      }
      case 'type': {
        const el = (await locate(step.target)) as HTMLInputElement;
        await deps.pointAt(el, signal);
        el.focus();
        for (let length = 1; length <= step.text.length; length += 1) {
          if (signal.aborted) return;
          setInputValue(el, step.text.slice(0, length));
          await deps.sleep(TYPE_KEY_MS + Math.round(Math.random() * TYPE_KEY_JITTER_MS), signal);
        }
        return;
      }
      case 'point': {
        const el = await locate(step.target, step.optional);
        if (el) await deps.pointAt(el, signal);
        return;
      }
      case 'scroll': {
        const el = (await locate(step.target)) as HTMLElement;
        scrollTargetBy(el, step.by);
        await deps.sleep(SCROLL_PAUSE_MS, signal);
        return;
      }
    }
  };

  for (let index = startAt % scenes.length; ; index = (index + 1) % scenes.length) {
    if (signal.aborted) return;
    const scene = scenes[index];
    deps.onScene?.(index, scene);
    if (signal.aborted) return;
    try {
      await deps.sceneStart?.(index, scene, signal);
      await deps.beforeScene?.(scene, signal);
      for (const [stepIndex, step] of scene.steps.entries()) {
        if (signal.aborted) return;
        deps.onStep?.(index, stepIndex);
        await runStep(step);
      }
    } catch {
      if (signal.aborted) return;
      try {
        await deps.sleep(FAILED_SCENE_PAUSE_MS, signal);
      } catch {
        return;
      }
    }
  }
}
