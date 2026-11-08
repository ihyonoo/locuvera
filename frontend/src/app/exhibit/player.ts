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
  | { do: 'clip'; src: string };

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
  playClip: (src: string, signal: AbortSignal) => Promise<void>;
  beforeScene?: (scene: Scene, signal: AbortSignal) => Promise<void>;
  waitForTarget?: (target: Target, signal: AbortSignal, timeoutMs: number) => Promise<HTMLElement>;
  onScene?: (index: number, scene: Scene) => void;
};

// 화면이 데이터를 받아 그릴 때까지 기다리는 한도
const TARGET_TIMEOUT_MS = 15_000;
// 없을 수도 있는 대상은 짧게만 기다린다
const OPTIONAL_TARGET_TIMEOUT_MS = 3_000;
export const CLICK_PAUSE_MS = 600;
const TYPE_KEY_MS = 90;
const SCROLL_PAUSE_MS = 900;
// 장면이 실패하면 잠깐 쉬고 다음 장면으로 — 모든 장면이 곧바로 실패해도 브라우저를 붙잡지 않게
const FAILED_SCENE_PAUSE_MS = 3_000;

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
      case 'clip':
        await deps.playClip(step.src, signal);
        return;
      case 'click': {
        const el = await locate(step.target, step.optional);
        if (!el) return;
        await deps.pointAt(el, signal);
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
          await deps.sleep(TYPE_KEY_MS, signal);
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
      await deps.beforeScene?.(scene, signal);
      for (const step of scene.steps) {
        if (signal.aborted) return;
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
