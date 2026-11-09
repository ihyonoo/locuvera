import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExhibitController } from './controller';

type Run = { startAt: number; signal: AbortSignal; onScene: (index: number) => void };

function setup(sceneCount = 3) {
  const runs: Run[] = [];
  const modes: string[] = [];
  const controller = createExhibitController({
    sceneCount,
    idleMs: 60_000,
    resumeGraceMs: 2_000,
    run: (startAt, signal, onScene) => {
      runs.push({ startAt, signal, onScene });
      return new Promise<void>(() => {});
    },
    onMode: (mode) => modes.push(mode),
  });
  return { controller, runs, modes };
}

describe('createExhibitController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts the automatic tour from the first scene', () => {
    const { controller, runs, modes } = setup();

    controller.start();

    expect(runs).toHaveLength(1);
    expect(runs[0].startAt).toBe(0);
    expect(modes).toEqual(['auto']);
  });

  it('stops the tour as soon as a person touches the screen', () => {
    const { controller, runs, modes } = setup();
    controller.start();

    controller.humanInput();

    expect(runs[0].signal.aborted).toBe(true);
    expect(modes.at(-1)).toBe('manual');
  });

  it('resumes from the next scene after 60 seconds without input', () => {
    const { controller, runs, modes } = setup();
    controller.start();
    runs[0].onScene(1);
    controller.humanInput();

    vi.advanceTimersByTime(59_999);
    expect(runs).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(runs).toHaveLength(2);
    expect(runs[1].startAt).toBe(2);
    expect(modes.at(-1)).toBe('auto');
  });

  it('restarts the idle countdown on every input', () => {
    const { controller, runs } = setup();
    controller.start();
    controller.humanInput();

    vi.advanceTimersByTime(50_000);
    controller.humanInput();
    vi.advanceTimersByTime(50_000);
    expect(runs).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    expect(runs).toHaveLength(2);
  });

  it('wraps to the first scene after the last one', () => {
    const { controller, runs } = setup(3);
    controller.start();
    runs[0].onScene(2);
    controller.humanInput();

    vi.advanceTimersByTime(60_000);

    expect(runs[1].startAt).toBe(0);
  });

  it('goes back to the tour right away when asked, from the next scene', () => {
    const { controller, runs, modes } = setup();
    controller.start();
    runs[0].onScene(1);
    controller.humanInput();

    controller.resume();

    expect(runs).toHaveLength(2);
    expect(runs[1].startAt).toBe(2);
    expect(modes.at(-1)).toBe('auto');
    vi.advanceTimersByTime(60_000);
    expect(runs).toHaveLength(2);
  });

  it('ignores the hand leaving the mouse for a moment after going back', () => {
    const { controller, runs, modes } = setup();
    controller.start();
    controller.humanInput();
    controller.resume();

    controller.humanInput();
    expect(runs[1].signal.aborted).toBe(false);
    expect(modes.at(-1)).toBe('auto');

    vi.advanceTimersByTime(2_000);
    controller.humanInput();
    expect(runs[1].signal.aborted).toBe(true);
    expect(modes.at(-1)).toBe('manual');
  });

  it('does nothing when asked to go back while already touring', () => {
    const { controller, runs } = setup();
    controller.start();

    controller.resume();

    expect(runs).toHaveLength(1);
  });

  it('cancels the tour and the countdown when stopped', () => {
    const { controller, runs } = setup();
    controller.start();
    controller.humanInput();

    controller.stop();
    vi.advanceTimersByTime(120_000);

    expect(runs).toHaveLength(1);
  });
});
