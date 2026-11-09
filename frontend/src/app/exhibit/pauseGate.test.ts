import { describe, expect, it } from 'vitest';
import { createPauseGate } from './pauseGate';

const live = () => new AbortController().signal;

describe('createPauseGate', () => {
  it('passes straight through while not paused', async () => {
    const gate = createPauseGate();
    expect(gate.paused()).toBe(false);
    await expect(gate.wait(live())).resolves.toBeUndefined();
  });

  it('holds the waiter until resume, then lets it through', async () => {
    const gate = createPauseGate();
    gate.pause();
    expect(gate.paused()).toBe(true);

    let released = false;
    const waiting = gate.wait(live()).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    gate.resume();
    await waiting;
    expect(released).toBe(true);
    expect(gate.paused()).toBe(false);
  });

  it('releases every pending waiter on a single resume', async () => {
    const gate = createPauseGate();
    gate.pause();
    const all = Promise.all([gate.wait(live()), gate.wait(live()), gate.wait(live())]);
    gate.resume();
    await expect(all).resolves.toHaveLength(3);
  });

  it('rejects a waiter when its signal aborts, without touching others', async () => {
    const gate = createPauseGate();
    gate.pause();
    const controller = new AbortController();
    const aborted = gate.wait(controller.signal);
    const other = gate.wait(live());

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    let otherDone = false;
    void other.then(() => {
      otherDone = true;
    });
    await Promise.resolve();
    expect(otherDone).toBe(false);

    gate.resume();
    await expect(other).resolves.toBeUndefined();
  });

  it('rejects immediately when paused and the signal is already aborted', async () => {
    const gate = createPauseGate();
    gate.pause();
    const controller = new AbortController();
    controller.abort();
    await expect(gate.wait(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resume is a no-op when nothing is waiting', () => {
    const gate = createPauseGate();
    expect(() => gate.resume()).not.toThrow();
    expect(gate.paused()).toBe(false);
  });
});
