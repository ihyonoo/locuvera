import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 다크 토큰이 WCAG AA 대비를 지키는지 theme.css 값을 직접 읽어 계산한다 (TRD 4.8 대비 표)
const css = readFileSync(resolve(__dirname, 'theme.css'), 'utf8');

function block(pattern: RegExp): string {
  const match = pattern.exec(css);
  if (!match) throw new Error(`block not found: ${pattern}`);
  // 여는 중괄호부터 짝이 맞는 닫는 중괄호까지
  let depth = 0;
  for (let i = match.index + match[0].length - 1; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(match.index, i + 1);
  }
  throw new Error('unbalanced block');
}

function tokens(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const darkBlock = block(/@media screen\s*\{\s*html\.dark\s*\{/);
const light = tokens(block(/^:root\s*\{/m));
const dark = { ...light, ...tokens(darkBlock) };

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  throw new Error(`unsupported color: ${value}`);
}

// 반투명 색은 아래 색 위에 sRGB로 합성한다
function over(top: Rgba, below: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => Math.round(a * top[i] + (1 - a) * below[i])).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: string, bg: string): number {
  const below = parseColor(dark[bg] ?? bg);
  const above = over(parseColor(dark[fg] ?? fg), below);
  const [hi, lo] = [luminance(above), luminance(below)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('dark theme tokens', () => {
  it('apply only on screen so printouts stay light', () => {
    expect(darkBlock).toMatch(/color-scheme:\s*dark/);
  });

  it('invert the 2D floor plan on screen only and blend its black into the card behind', () => {
    const rule = block(/@media screen\s*\{\s*html\.dark \.floor-map__plan\s*\{/);
    expect(rule).toMatch(/filter:\s*invert\(1\) hue-rotate\(180deg\)/);
    expect(rule).toMatch(/mix-blend-mode:\s*screen/);
  });

  it('use a gray-black background (saturation ≤ 10%, lightness ≤ 15%)', () => {
    const [r, g, b] = parseColor(dark['--background']).map((c) => c / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    expect(l).toBeLessThanOrEqual(0.15);
    expect(s).toBeLessThanOrEqual(0.1);
  });

  it('keep the light solid teal identical to the current primary', () => {
    expect(light['--primary-solid']).toBe(light['--primary']);
    expect(css).toMatch(/--color-primary-solid:\s*var\(--primary-solid\)/);
  });

  it.each([
    ['::selection', '--selection-background'],
    ['.skeleton::after', '--skeleton-shimmer'],
    ['.pager-cell--active', '--primary-solid'],
    ['.pager-cell--active:hover', '--primary-solid'],
  ])('%s takes its color from %s so dark mode can swap it', (selector, token) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(block(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{`))).toContain(`var(${token})`);
  });

  it.each([
    // 글자 4.5:1
    ['--foreground', '--background', 4.5],
    ['--foreground', '--card', 4.5],
    ['--foreground', '--muted', 4.5],
    ['--foreground', '--accent', 4.5],
    ['--muted-foreground', '--background', 4.5],
    ['--muted-foreground', '--card', 4.5],
    ['--muted-foreground', '--muted', 4.5],
    ['--primary', '--background', 4.5],
    ['--primary', '--card', 4.5],
    ['--primary', '--input-background', 4.5],
    ['--ok-fg', '--ok-bg', 4.5],
    ['--warn-fg', '--warn-bg', 4.5],
    ['--err-fg', '--err-bg', 4.5],
    ['#ffffff', '--primary-solid', 4.5],
    // UI 요소·선 3:1
    ['--primary-solid', '--card', 3],
    ['--input', '--input-background', 3],
    ['--input', '--card', 3],
    ['--input', '--background', 3],
    ['--ring', '--background', 3],
    ['--ring', '--card', 3],
    ['--ring', '--input-background', 3],
  ])('%s on %s reaches %s:1', (fg, bg, minimum) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(minimum);
  });
});
