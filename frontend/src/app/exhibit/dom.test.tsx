import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TargetNotFoundError, findTarget, scrollTargetBy, setInputValue, waitForTarget } from './dom';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('findTarget', () => {
  it('finds the first element matching both the selector and the text', () => {
    document.body.innerHTML = '<button class="row">제세동기-001</button><button class="row">수액펌프-001</button>';
    expect(findTarget({ selector: '.row', text: '수액펌프' })?.textContent).toBe('수액펌프-001');
  });

  it('returns null when nothing matches', () => {
    document.body.innerHTML = '<button class="row">제세동기-001</button>';
    expect(findTarget({ selector: '.row', text: '수액펌프' })).toBeNull();
  });
});

describe('setInputValue', () => {
  it('updates a React controlled input', () => {
    function Field() {
      const [value, setValue] = useState('');
      return (
        <>
          <input aria-label="장비" value={value} onChange={(e) => setValue(e.target.value)} />
          <span data-testid="echo">{value}</span>
        </>
      );
    }
    render(<Field />);

    act(() => setInputValue(screen.getByLabelText('장비') as HTMLInputElement, '수액'));

    expect(screen.getByTestId('echo')).toHaveTextContent('수액');
  });
});

describe('scrollTargetBy', () => {
  it('moves the scroll position of the element', () => {
    document.body.innerHTML = '<div id="box"></div>';
    const box = document.getElementById('box') as HTMLElement;

    scrollTargetBy(box, 300);

    expect(box.scrollTop).toBe(300);
  });
});

describe('waitForTarget', () => {
  it('waits until the element appears', async () => {
    const pending = waitForTarget({ selector: '#late' }, new AbortController().signal, 2000);
    setTimeout(() => {
      document.body.innerHTML = '<div id="late"></div>';
    }, 50);

    await expect(pending).resolves.toHaveProperty('id', 'late');
  });

  it('gives up after the timeout', async () => {
    await expect(waitForTarget({ selector: '#never' }, new AbortController().signal, 150)).rejects.toBeInstanceOf(
      TargetNotFoundError,
    );
  });

  it('stops waiting when aborted', async () => {
    const controller = new AbortController();
    const pending = waitForTarget({ selector: '#never' }, controller.signal, 5000);
    controller.abort();

    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });
});
