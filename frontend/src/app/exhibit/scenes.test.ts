import { describe, expect, it } from 'vitest';
import { router } from '../routes';
import type { Step, Target } from './player';
import { EXHIBIT_SCENES } from './scenes';

// 대본이 기대는 화면 마크업이 아직 소스에 있는지 본다 — 화면 문구를 바꾸면 여기서 먼저 깨진다
const SOURCES = import.meta.glob(
  [
    '../pages/*.tsx',
    '!../pages/*.test.tsx',
    '../components/**/*.tsx',
    '!../components/**/*.test.tsx',
    '../lib/*.ts',
    '!../lib/*.test.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const CORPUS = Object.values(SOURCES).join('\n');

// 화면 소스가 아니라 운영 데이터에서 오는 글자
const DATA_TEXTS = new Set(['수액펌프-001', '#3251']);

// 쓰기 동작으로 이어지는 단추 글자
const WRITE_WORDS = /대여|반납|저장|승인|거절|삭제|인쇄|로그아웃|해제|탈퇴|바인딩/;

// 대본이 쓰는 단계 종류 — 보안 실연은 터미널로 옮겨 attack·clip 단계가 없다
const STEP_KINDS: Step['do'][] = ['go', 'click', 'type', 'point', 'scroll', 'wait', 'ready', 'caption'];

const allSteps = (): Step[] => EXHIBIT_SCENES.flatMap((scene) => scene.steps);

function targetsOf(step: Step): Target[] {
  return 'target' in step ? [step.target] : [];
}

function markupTokens(target: Target): string[] {
  const classes = [...target.selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const attributeValues = [...target.selector.matchAll(/\[[\w-]+="([^"]+)"\]/g)].map((m) => m[1]);
  const text = target.text && !DATA_TEXTS.has(target.text) ? [target.text] : [];
  return [...classes, ...attributeValues, ...text];
}

describe('EXHIBIT_SCENES', () => {
  it('tours the three app screens only, with no attack or clip steps', () => {
    expect(EXHIBIT_SCENES.map((scene) => scene.id)).toEqual(['location', 'verification', 'utilization']);
    for (const step of allSteps()) {
      expect(STEP_KINDS).toContain(step.do);
    }
  });

  it('tours the floors above 1F, where the map opens, before picking the real equipment', () => {
    const steps = EXHIBIT_SCENES[0].steps;
    const floors = steps.flatMap((step) =>
      step.do === 'click' && step.target.selector.startsWith('button.staff-floor') ? [step.target.selector] : [],
    );
    expect(floors).toEqual([2, 3, 4, 5].map((floor) => `button.staff-floor[aria-label="${floor}층"]`));

    const lastFloor = steps.findIndex((step) => 'target' in step && step.target.selector.includes('5층'));
    const pick = steps.findIndex((step) => 'target' in step && step.target.selector === 'button.staff-row');
    expect(lastFloor).toBeLessThan(pick);
  });

  it('explains in plain words, without on-chain or Merkle jargon', () => {
    const captions = allSteps().flatMap((step) => (step.do === 'caption' ? [step.text] : []));
    for (const text of captions) expect(text).not.toMatch(/온체인|머클/);
  });

  it('keeps the opening caption up through the floor tour, until the name search', () => {
    const captions = EXHIBIT_SCENES[0].steps.flatMap((step) => (step.do === 'caption' ? [step.text] : []));
    expect(captions[1]).toBe('장비명 검색');
  });

  it('keeps the judging caption up while the busiest type opens, with no caption after it', () => {
    const steps = EXHIBIT_SCENES.find((scene) => scene.id === 'utilization')!.steps;
    const pick = steps.findIndex((step) => step.do === 'click' && step.target.text === '추가 구매 검토');
    expect(pick).toBeGreaterThan(-1);
    expect(steps.slice(pick - 1).some((step) => step.do === 'caption')).toBe(false);
  });

  it('explains every scene in a caption before anything moves on screen', () => {
    for (const scene of EXHIBIT_SCENES) {
      const first = scene.steps.find((step) => !['go', 'wait', 'ready'].includes(step.do));
      expect(first?.do, scene.id).toBe('caption');
    }
  });

  it('only visits screens that exist', () => {
    const paths = new Set(router.routes.map((route) => route.path));
    for (const step of allSteps()) {
      if (step.do === 'go') expect(paths).toContain(step.to);
    }
  });

  it('enters each screen with the demo role that the screen allows', () => {
    for (const scene of EXHIBIT_SCENES) {
      for (const step of scene.steps) {
        if (step.do !== 'go') continue;
        expect(scene.role).toBe(step.to === '/equipment' ? 'staff' : 'admin');
      }
    }
  });

  it('never hides the simulation data', () => {
    for (const step of allSteps()) {
      if (step.do === 'click') expect(step.target.text ?? '').not.toMatch(/시뮬레이션/);
    }
  });

  it('never presses a button that writes', () => {
    for (const step of allSteps()) {
      if (step.do === 'click') expect(step.target.text ?? '').not.toMatch(WRITE_WORDS);
    }
  });

  it('relies only on markup that the screens still render', () => {
    for (const step of allSteps()) {
      for (const target of targetsOf(step)) {
        for (const token of markupTokens(target)) {
          expect(CORPUS, `${target.selector} ${target.text ?? ''}`).toContain(token);
        }
      }
    }
  });
});
