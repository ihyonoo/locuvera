import { describe, expect, it } from 'vitest';
import { router } from '../routes';
import type { Step, Target } from './player';
import { EXHIBIT_SCENES, SECURITY_CLIPS } from './scenes';

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
  it('alternates the app screens with the three security clips', () => {
    const kinds = EXHIBIT_SCENES.map((scene) => (scene.steps.some((step) => step.do === 'clip') ? 'clip' : 'app'));
    expect(kinds).toEqual(['app', 'clip', 'app', 'clip', 'app', 'clip', 'app']);

    const clips = allSteps().flatMap((step) => (step.do === 'clip' ? [step.src] : []));
    expect(clips).toEqual(SECURITY_CLIPS.map((clip) => clip.src));
  });

  it('serves every clip from the exhibit folder', () => {
    for (const clip of SECURITY_CLIPS) {
      expect(clip.src).toMatch(/^\/exhibit\/[\w-]+\.mp4$/);
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
