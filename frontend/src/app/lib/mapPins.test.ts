import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_PIN_HIT_SIZE, PIN_COLORS, PIN_MAP_RATIO, PIN_SIZE_RATIO, pinDiameter, pinHitSize } from './mapPins';

describe('pinDiameter', () => {
  it('is 2% of the map box width', () => {
    expect(PIN_MAP_RATIO).toBe(0.02);
    expect(pinDiameter(330)).toBeCloseTo(6.6);
    expect(pinDiameter(700)).toBeCloseTo(14);
  });

  it('is 0 for a map box that is not laid out yet', () => {
    expect(pinDiameter(0)).toBe(0);
  });
});

describe('PIN_SIZE_RATIO', () => {
  it('keeps the old 14 : 22 : 40 proportions for the spotlight dot and its ring', () => {
    expect(14 * PIN_SIZE_RATIO.spotlight).toBeCloseTo(22);
    expect(14 * PIN_SIZE_RATIO.ring).toBeCloseTo(40);
  });
});

describe('pinHitSize', () => {
  it('never drops below the 28px touch target', () => {
    expect(MIN_PIN_HIT_SIZE).toBe(28);
    expect(pinHitSize(6.6)).toBe(28);
  });

  it('grows with a pin larger than the touch target', () => {
    expect(pinHitSize(40)).toBe(40);
  });
});

describe('PIN_COLORS', () => {
  const css = readFileSync(resolve(__dirname, '../../styles/theme.css'), 'utf8');
  const markerColor = (cls: string) =>
    new RegExp(`\\.${cls}\\s*\\{[^}]*background:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1];

  it('match the 2D marker classes so 2D dots and 3D balls share one color', () => {
    expect(markerColor('map-marker-ok')).toBe(PIN_COLORS.available);
    expect(markerColor('map-marker-err')).toBe(PIN_COLORS.checked_out);
    expect(markerColor('map-marker-neutral')).toBe(PIN_COLORS.inactive);
  });

  // 2D 점은 흰 테두리 대신 반사광 그라데이션 — 3D 광택 구슬과 같은 느낌
  it('draws 2D dots with a highlight instead of a white rim', () => {
    expect(css).not.toMatch(/0 0 0 1\.5px #fff/);
    for (const cls of ['map-marker-ok', 'map-marker-err', 'map-marker-neutral']) {
      expect(css).toMatch(new RegExp(`\\.map-marker-dot\\.${cls}\\s*\\{[^}]*radial-gradient`));
    }
  });

  // 핀은 흰 테두리 없이 흰 평면도·밝은 바닥 위에 놓인다 — 흰색과 WCAG 그래픽 대비 3:1 (PRD R-21)
  it.each(Object.entries(PIN_COLORS))('%s (%s) stands out 3:1 on the white floor plan', (_, hex) => {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(1.05 / (luminance + 0.05)).toBeGreaterThanOrEqual(3);
  });
});
