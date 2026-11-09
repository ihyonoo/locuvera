import { describe, expect, it } from 'vitest';
import type { Scene } from './player';
import { approach, createTimeline, progressAt, sectionFill } from './progress';

const SCENES: Scene[] = [
  {
    id: 'a',
    title: 'A',
    steps: [
      { do: 'wait', ms: 1000 },
      { do: 'wait', ms: 2000 },
    ],
  },
  { id: 'b', title: 'B', steps: [{ do: 'wait', ms: 3000 }] },
];
const CARD_MS = 500;

describe('createTimeline', () => {
  it('lays each scene out as its title card followed by its steps, back to back', () => {
    const timeline = createTimeline(SCENES, CARD_MS);

    expect(timeline.totalMs).toBe(7000);
    expect(timeline.span(0)).toEqual({ start: 0, ms: 500 });
    expect(timeline.span(0, 0)).toEqual({ start: 500, ms: 1000 });
    expect(timeline.span(0, 1)).toEqual({ start: 1500, ms: 2000 });
    expect(timeline.span(1)).toEqual({ start: 3500, ms: 500 });
    expect(timeline.span(1, 0)).toEqual({ start: 4000, ms: 3000 });
  });

  it('gives each scene a section from its title card to its last step', () => {
    expect(createTimeline(SCENES, CARD_MS).scenes).toEqual([
      { start: 0, ms: 3500 },
      { start: 3500, ms: 3500 },
    ]);
  });
});

describe('progressAt', () => {
  it('moves through the span as time passes', () => {
    expect(progressAt({ start: 500, ms: 1000 }, 400, 7000)).toBeCloseTo(900 / 7000);
  });

  it('stops at the end of the span when the step runs longer than expected', () => {
    expect(progressAt({ start: 500, ms: 1000 }, 5000, 7000)).toBeCloseTo(1500 / 7000);
  });
});

describe('approach', () => {
  it('slides toward a target far ahead instead of jumping there', () => {
    const next = approach(0.2, 0.5, 16);

    expect(next).toBeGreaterThan(0.2);
    expect(next).toBeLessThan(0.5);
  });

  it('keeps up with a target that is only a frame ahead', () => {
    expect(approach(0.2, 0.2001, 16)).toBe(0.2001);
  });

  it('snaps straight back when a new round starts', () => {
    expect(approach(0.95, 0.01, 16)).toBe(0.01);
  });
});

describe('sectionFill', () => {
  const section = { start: 1000, ms: 2000 };

  it('fills the section the bar is in up to where it is', () => {
    expect(sectionFill(section, 2000)).toBe(0.5);
  });

  it('leaves later sections empty and earlier ones full', () => {
    expect(sectionFill(section, 500)).toBe(0);
    expect(sectionFill(section, 5000)).toBe(1);
  });
});
