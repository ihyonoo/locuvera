import { describe, expect, it, vi } from 'vitest';
import { watchHumanInput } from './humanInput';

// jsdom이 만든 이벤트는 모두 isTrusted가 false라 사람 입력으로 치는 판정을 바꿔 시험한다
const fromPerson = () => true;

function move(x: number, y: number) {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
}

describe('watchHumanInput', () => {
  it('ignores events made by script', () => {
    const onHuman = vi.fn();
    const stop = watchHumanInput(window, onHuman);

    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    move(0, 0);
    move(200, 200);

    expect(onHuman).not.toHaveBeenCalled();
    stop();
  });

  it.each(['pointerdown', 'keydown', 'wheel', 'touchstart'])('reports %s from a person', (type) => {
    const onHuman = vi.fn();
    const stop = watchHumanInput(window, onHuman, fromPerson);

    window.dispatchEvent(new Event(type));

    expect(onHuman).toHaveBeenCalledTimes(1);
    stop();
  });

  it('ignores a small mouse jitter but reports a real move', () => {
    const onHuman = vi.fn();
    const stop = watchHumanInput(window, onHuman, fromPerson);

    move(100, 100);
    move(103, 102);
    expect(onHuman).not.toHaveBeenCalled();

    move(120, 100);
    expect(onHuman).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops listening after cleanup', () => {
    const onHuman = vi.fn();
    const stop = watchHumanInput(window, onHuman, fromPerson);
    stop();

    window.dispatchEvent(new Event('pointerdown'));

    expect(onHuman).not.toHaveBeenCalled();
  });
});
