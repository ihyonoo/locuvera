import { afterEach, describe, expect, it, vi } from 'vitest';
import { TargetNotFoundError } from './dom';
import { CLICK_PAUSE_MS, type PlayerDeps, type Scene, runExhibit } from './player';

afterEach(() => {
  document.body.innerHTML = '';
});

// 장면 시작을 센다 — 정해진 횟수에 이르면 재생을 멈춘다
function stopAfterScenes(count: number, controller: AbortController) {
  let seen = 0;
  return vi.fn(() => {
    seen += 1;
    if (seen > count) controller.abort();
  });
}

function makeDeps(controller: AbortController, sceneLimit: number, overrides: Partial<PlayerDeps> = {}) {
  const log: string[] = [];
  const deps: PlayerDeps = {
    navigate: vi.fn((to: string) => {
      log.push(`go ${to}`);
    }),
    sleep: vi.fn(async (ms: number) => {
      log.push(`wait ${ms}`);
    }),
    pointAt: vi.fn(async (el: HTMLElement) => {
      log.push(`point ${el.id}`);
    }),
    beforeScene: vi.fn(async (scene: Scene) => {
      log.push(`enter ${scene.id}`);
    }),
    waitForTarget: vi.fn(async (target) => {
      const el = document.querySelector<HTMLElement>(target.selector);
      if (!el) throw new TargetNotFoundError(target);
      return el;
    }),
    onScene: stopAfterScenes(sceneLimit, controller),
    ...overrides,
  };
  return { log, deps };
}

const SCENES: Scene[] = [
  {
    id: 'search',
    title: '장비 검색',
    role: 'staff',
    steps: [
      { do: 'go', to: '/equipment' },
      { do: 'click', target: { selector: '#row' } },
      { do: 'wait', ms: 500 },
    ],
  },
  {
    id: 'devices',
    title: '기기 상태',
    role: 'admin',
    steps: [
      { do: 'go', to: '/admin/devices' },
      { do: 'wait', ms: 400 },
    ],
  },
];

describe('runExhibit', () => {
  it('plays each step in order and loops back to the first scene', async () => {
    document.body.innerHTML = '<button id="row"></button>';
    const row = document.getElementById('row') as HTMLElement;
    const clicked = vi.fn();
    row.addEventListener('click', clicked);
    const controller = new AbortController();
    const { log, deps } = makeDeps(controller, 3);

    await runExhibit(SCENES, 0, controller.signal, deps);

    const meaningful = log.filter((line) => line !== `wait ${CLICK_PAUSE_MS}`);
    expect(meaningful).toEqual([
      'enter search',
      'go /equipment',
      'point row',
      'wait 500',
      'enter devices',
      'go /admin/devices',
      'wait 400',
      'enter search',
      'go /equipment',
      'point row',
      'wait 500',
    ]);
    expect(clicked).toHaveBeenCalledTimes(2);
  });

  it('opens each scene with its title card and passes captions and readiness checks through', async () => {
    document.body.innerHTML = '<div id="map"></div>';
    const controller = new AbortController();
    const { log, deps } = makeDeps(controller, 1);
    deps.sceneStart = vi.fn(async (index: number, scene: Scene) => {
      log.push(`card ${index} ${scene.title}`);
    });
    deps.caption = vi.fn(async (text: string) => {
      log.push(`caption ${text}`);
    });

    await runExhibit(
      [
        {
          id: 'a',
          title: '장면',
          role: 'staff',
          steps: [
            { do: 'go', to: '/a' },
            { do: 'ready', target: { selector: '#map' } },
            { do: 'caption', text: '설명' },
          ],
        },
      ],
      0,
      controller.signal,
      deps,
    );

    expect(log).toEqual(['card 0 장면', 'enter a', 'go /a', 'caption 설명']);
  });

  it('presses the cursor just before clicking', async () => {
    document.body.innerHTML = '<button id="row"></button>';
    const order: string[] = [];
    document.getElementById('row')?.addEventListener('click', () => order.push('click'));
    const controller = new AbortController();
    const { deps } = makeDeps(controller, 1);
    deps.press = vi.fn(async () => {
      order.push('press');
    });

    await runExhibit(
      [{ id: 'c', title: '클릭', role: 'staff', steps: [{ do: 'click', target: { selector: '#row' } }] }],
      0,
      controller.signal,
      deps,
    );

    expect(order).toEqual(['press', 'click']);
  });

  it('starts from the given scene', async () => {
    document.body.innerHTML = '<button id="row"></button>';
    const controller = new AbortController();
    const { log, deps } = makeDeps(controller, 1);

    await runExhibit(SCENES, 1, controller.signal, deps);

    expect(log[0]).toBe('enter devices');
  });

  it('types the text one character at a time', async () => {
    document.body.innerHTML = '<input id="search" />';
    const values: string[] = [];
    document.getElementById('search')?.addEventListener('input', (e) => {
      values.push((e.target as HTMLInputElement).value);
    });
    const controller = new AbortController();
    const { deps } = makeDeps(controller, 1);

    await runExhibit(
      [
        {
          id: 'type',
          title: '입력',
          role: 'staff',
          steps: [{ do: 'type', target: { selector: '#search' }, text: '수액' }],
        },
      ],
      0,
      controller.signal,
      deps,
    );

    expect(values).toEqual(['수', '수액']);
  });

  it('scrolls the target by the given amount', async () => {
    document.body.innerHTML = '<div id="body"></div>';
    const controller = new AbortController();
    const { deps } = makeDeps(controller, 1);

    await runExhibit(
      [
        {
          id: 'scroll',
          title: '스크롤',
          role: 'admin',
          steps: [{ do: 'scroll', target: { selector: '#body' }, by: 400 }],
        },
      ],
      0,
      controller.signal,
      deps,
    );

    expect(document.getElementById('body')?.scrollTop).toBe(400);
  });

  it('skips the rest of a scene when its target never appears', async () => {
    const controller = new AbortController();
    const { log, deps } = makeDeps(controller, 2);

    await runExhibit(SCENES, 0, controller.signal, deps);

    expect(log).not.toContain('wait 500');
    expect(log).toContain('enter devices');
  });

  it.each(['click', 'point'] as const)('moves on when an optional %s target is missing', async (kind) => {
    const controller = new AbortController();
    const { log, deps } = makeDeps(controller, 1);

    await runExhibit(
      [
        {
          id: 'optional',
          title: '선택',
          role: 'admin',
          steps: [
            { do: kind, target: { selector: '#missing' }, optional: true },
            { do: 'wait', ms: 700 },
          ],
        },
      ],
      0,
      controller.signal,
      deps,
    );

    expect(log).toContain('wait 700');
  });

  it('runs nothing more once aborted', async () => {
    document.body.innerHTML = '<button id="row"></button>';
    const clicked = vi.fn();
    document.getElementById('row')?.addEventListener('click', clicked);
    const controller = new AbortController();
    const { deps } = makeDeps(controller, 5, {
      navigate: vi.fn(() => controller.abort()),
    });

    await runExhibit(SCENES, 0, controller.signal, deps);

    expect(clicked).not.toHaveBeenCalled();
  });
});
