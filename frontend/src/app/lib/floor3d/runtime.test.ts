import { describe, expect, it } from 'vitest';
import {
  acesFilmicInverse,
  createQualityGovernor,
  equipmentLayerKey,
  pinScreenDiameter,
  pinWorldDiameter,
  placeTagLabels,
  tagColors,
  worldPerPixel,
  type Rect,
  type TagSpot,
} from './runtime';
import { PIN_COLORS } from '../mapPins';

describe('placeTagLabels', () => {
  const view: Rect = { left: 0, top: 0, right: 800, bottom: 600 };
  // 점 중심(x, y), 이름표 크기, 점의 화면 반지름(r)
  const dot = (id: string, x: number, y: number, w = 80, r = 7) => ({ id, x, y, w, h: 20, r });
  const rectOf = (s: TagSpot, w = 80): Rect => ({
    left: s.x - w / 2,
    top: s.y - 10,
    right: s.x + w / 2,
    bottom: s.y + 10,
  });
  const overlap = (a: Rect, b: Rect) => a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;

  it('puts the label just above its dot when nothing is in the way', () => {
    const s = placeTagLabels([dot('a', 300, 300)], view).get('a')!;
    expect(s.x).toBe(300);
    // 점 반지름 7 + 간격 4
    expect(rectOf(s).bottom).toBe(300 - 11);
    expect(s.moved).toBe(false);
  });

  it('keeps the label clear of a larger dot', () => {
    const s = placeTagLabels([dot('a', 300, 300, 80, 20)], view).get('a')!;
    // 점 반지름 20 + 간격 4
    expect(rectOf(s).bottom).toBe(300 - 24);
  });

  it('moves a label that would cover another label', () => {
    const placed = placeTagLabels([dot('a', 300, 300), dot('b', 320, 300)], view);
    const [a, b] = [placed.get('a')!, placed.get('b')!];
    expect(overlap(rectOf(a), rectOf(b))).toBe(false);
    expect(a.moved).toBe(false);
    expect(b.moved).toBe(true);
  });

  it('never covers another dot', () => {
    // b의 점이 a 이름표의 기본 자리 안에 있다
    const dots = [dot('b', 300, 280), dot('a', 300, 300)];
    const placed = placeTagLabels(dots, view);
    for (const d of dots)
      for (const other of dots) {
        if (d === other) continue;
        const dotBox = { left: other.x - 7, top: other.y - 7, right: other.x + 7, bottom: other.y + 7 };
        expect(overlap(rectOf(placed.get(d.id)!), dotBox)).toBe(false);
      }
  });

  it('keeps the label on screen by dropping it below a dot near the top edge', () => {
    const s = placeTagLabels([dot('a', 300, 15)], view).get('a')!;
    expect(rectOf(s).top).toBeGreaterThanOrEqual(view.top);
    expect(s.y).toBeGreaterThan(15);
  });

  it('finds every label a free spot in a tight cluster when there is room around it', () => {
    const dots = Array.from({ length: 8 }, (_, i) =>
      dot(`t${i}`, 300 + (i % 4) * 12, 300 + Math.floor(i / 4) * 12, 110),
    );
    const placed = placeTagLabels(dots, view);
    const rects = dots.map((d) => rectOf(placed.get(d.id)!, 110));
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBe(false);
  });

  it('drops a blocked label just below its dot rather than stacking it rows above', () => {
    // a의 이름표가 b의 기본 자리(점 위)를 막는다
    const placed = placeTagLabels([dot('a', 300, 300), dot('b', 330, 318)], view);
    const b = placed.get('b')!;
    expect(b.y).toBeGreaterThan(318);
    expect(rectOf(b).top).toBeLessThanOrEqual(318 + 7 + 4 + 2);
  });

  it('never runs a moved label line through another label or dot', () => {
    // b는 a 바로 아래라 위로 비키면 선이 a의 점·이름표를 지난다. 화면 아래 끝이라 점 아래로도 못 간다
    const tight: Rect = { ...view, bottom: 345 };
    const placed = placeTagLabels([dot('a', 300, 300), dot('b', 300, 330)], tight);
    const [a, b] = [placed.get('a')!, placed.get('b')!];
    const blocks = [rectOf(a), { left: 293, top: 293, right: 307, bottom: 307 }];
    for (let t = 0.05; t < 1; t += 0.05) {
      const [x, y] = [300 + (b.x - 300) * t, 330 + (b.y - 330) * t];
      for (const r of blocks) expect(x > r.left && x < r.right && y > r.top && y < r.bottom).toBe(false);
    }
  });

  it('gives the first dot in the list its spot first', () => {
    const first = placeTagLabels([dot('b', 320, 300), dot('a', 300, 300)], view);
    expect(first.get('b')!.moved).toBe(false);
    expect(first.get('a')!.moved).toBe(true);
  });
});

describe('equipmentLayerKey', () => {
  const a = { tag_id: 'a', reader_id: 'M201', assetStatus: 'available' };
  const b = { tag_id: 'b', reader_id: 'M202', assetStatus: 'checked_out' };

  it('does not depend on the order equipment arrives in', () => {
    expect(equipmentLayerKey([a, b])).toBe(equipmentLayerKey([b, a]));
  });

  it('changes when a zone or status changes', () => {
    const base = equipmentLayerKey([a, b]);
    expect(equipmentLayerKey([{ ...a, reader_id: 'M203' }, b])).not.toBe(base);
    expect(equipmentLayerKey([{ ...a, assetStatus: 'inactive' }, b])).not.toBe(base);
    expect(equipmentLayerKey([a])).not.toBe(base);
  });
});

describe('createQualityGovernor', () => {
  const feed = (gov: ReturnType<typeof createQualityGovernor>, ms: number, frames: number) => {
    const changes: number[] = [];
    for (let i = 0; i < frames; i++) {
      const next = gov.record(ms);
      if (next !== null) changes.push(next);
    }
    return changes;
  };

  it('keeps full quality while frames stay under 33ms', () => {
    const gov = createQualityGovernor();
    expect(feed(gov, 16, 500)).toEqual([]);
    expect(gov.level).toBe(0);
  });

  it('ignores the first 10 frames after the first render', () => {
    const gov = createQualityGovernor();
    feed(gov, 200, 10);
    expect(feed(gov, 16, 60)).toEqual([]);
  });

  it('drops one step per slow 60-frame window, in order, without going back up', () => {
    const gov = createQualityGovernor();
    feed(gov, 16, 10);
    expect(feed(gov, 50, 60)).toEqual([1]);
    expect(feed(gov, 50, 60)).toEqual([2]);
    expect(feed(gov, 50, 60)).toEqual([3]);
    expect(feed(gov, 50, 600)).toEqual([]);
    expect(feed(gov, 5, 600)).toEqual([]);
    expect(gov.level).toBe(3);
  });
});

describe('tagColors', () => {
  it('writes the name of checked-out equipment in red on the white tag', () => {
    expect(tagColors('checked_out', false)).toEqual({ background: '#fff', color: '#dc2626' });
  });

  it('writes the name of available equipment in green on the white tag', () => {
    // 상태가 없으면 점처럼 사용 가능으로 본다
    for (const status of ['available', undefined])
      expect(tagColors(status, false), String(status)).toEqual({ background: '#fff', color: '#15803d' });
  });

  it('keeps the name of inactive equipment navy on the white tag', () => {
    expect(tagColors('inactive', false)).toEqual({ background: '#fff', color: '#0f2e4f' });
  });

  it('keeps the focused tag white on navy whatever the status', () => {
    expect(tagColors('checked_out', true)).toEqual({ background: '#0f2e4f', color: '#fff' });
    expect(tagColors('available', true)).toEqual({ background: '#0f2e4f', color: '#fff' });
  });

  describe('on the dark stage', () => {
    it('puts names on a dark chip in light status colors', () => {
      expect(tagColors('checked_out', false, true)).toEqual({ background: '#1a1b1e', color: '#f87171' });
      for (const status of ['available', undefined])
        expect(tagColors(status, false, true), String(status)).toEqual({ background: '#1a1b1e', color: '#4ade80' });
      expect(tagColors('inactive', false, true)).toEqual({ background: '#1a1b1e', color: '#e7e8ea' });
    });

    it('inverts the focused tag to navy on a light chip', () => {
      expect(tagColors('checked_out', true, true)).toEqual({ background: '#e7e8ea', color: '#0f2e4f' });
    });
  });
});

describe('worldPerPixel', () => {
  it('converts one screen pixel into scene units at the given depth', () => {
    // 시야각 90°면 깊이 100에서 화면 높이가 장면 200이다. 화면 200px이면 1px = 1
    expect(worldPerPixel(100, 90, 200)).toBeCloseTo(1);
  });

  it('grows with depth so a marker keeps its screen size when zooming out', () => {
    expect(worldPerPixel(300, 28, 400)).toBeCloseTo(3 * worldPerPixel(100, 28, 400));
  });
});

describe('pin size in the 3D scene', () => {
  it('turns 2% of the map box width at the first view into a scene length', () => {
    // 지도 상자 700px, 처음 화면에서 1px = 장면 3 → 지름 14px = 장면 42
    expect(pinWorldDiameter(700, 3)).toBeCloseTo(42);
  });

  it('shows that scene length as 2% of the map box at the first view', () => {
    const world = pinWorldDiameter(330, 2.5);
    expect(pinScreenDiameter(world, 2.5)).toBeCloseTo(6.6);
  });

  it('grows on screen like a photo when zooming in', () => {
    const world = pinWorldDiameter(330, 2.5);
    // 2배 확대하면 1px이 장면 길이로 절반이 된다
    expect(pinScreenDiameter(world, 1.25)).toBeCloseTo(13.2);
  });
});

// three의 ACESFilmicToneMapping(OutputPass, 노출 1)과 같은 식 — 역보정 결과를 되돌려 확인한다
function acesFilmic([r, g, b]: [number, number, number]): [number, number, number] {
  const input = [
    [0.59719, 0.35458, 0.04823],
    [0.076, 0.90834, 0.01566],
    [0.0284, 0.13383, 0.83777],
  ];
  const output = [
    [1.60475, -0.53108, -0.07367],
    [-0.10208, 1.10813, -0.00605],
    [-0.00327, -0.07276, 1.07602],
  ];
  const mul = (m: number[][], v: number[]) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const c = mul(input, [r / 0.6, g / 0.6, b / 0.6]).map(fit);
  return mul(output, c).map((x) => Math.min(1, Math.max(0, x))) as [number, number, number];
}

const toSrgbByte = (linear: number) =>
  Math.round(255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055));

describe('acesFilmicInverse', () => {
  it.each(Object.entries(PIN_COLORS))('makes %s balls come out as %s after tone mapping', (_, hex) => {
    const input = acesFilmicInverse(hex);
    expect(input.every((c) => c >= 0)).toBe(true);
    const shown = acesFilmic(input).map(toSrgbByte);
    const expected = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    shown.forEach((c, i) => expect(Math.abs(c - expected[i])).toBeLessThanOrEqual(1));
  });
});
