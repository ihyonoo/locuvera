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

function ratio(top: Rgba, below: Rgba): number {
  const above = over(top, below);
  const [hi, lo] = [luminance(above), luminance(below)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function contrast(fg: string, bg: string): number {
  return ratio(parseColor(dark[fg] ?? fg), parseColor(dark[bg] ?? bg));
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

// 인증 화면: 배경과 같은 색(--auth-bg)의 출입증 카드가 그림자로만 떠 보인다(뉴모피즘)
// 카드 안 글자는 라이트 토큰을 쓴다
// 입력칸·버튼 경계는 원본처럼 그림자와 흰 윤곽으로만 그린다 — 경계 3:1은 적용하지 않기로 했다(2026-10-31)
describe('auth card', () => {
  const surface = parseColor(tokens(block(/\n\s*\.auth-split\s*\{/))['--auth-bg']);
  const card = { ...light, ...tokens(block(/\n\s*\.auth-split__card\s*\{/)) };

  it.each([
    ['--foreground', 4.5],
    ['--muted-foreground', 4.5],
  ])('%s reaches %s:1 on the card', (fg, minimum) => {
    expect(ratio(parseColor(card[fg]), surface)).toBeGreaterThanOrEqual(minimum);
  });

  // 성공·오류 안내도 납작한 색 상자 대신 입력칸처럼 카드에 파인 홈으로 그린다
  it('draws notices as a groove in the card, not as a flat colored box', () => {
    const notice = block(/\n\.auth-split \.alert\s*\{/);
    expect(notice).toMatch(/border:\s*none/);
    expect(notice).toMatch(/background:\s*var\(--auth-bg\)/);
    expect(notice).toMatch(/box-shadow:\s*inset/);
    // 한국어는 낱말 중간에서 줄을 바꾸지 않고, 긴 이메일만 필요할 때 끊는다
    expect(notice).toMatch(/word-break:\s*keep-all/);
    expect(notice).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('keeps error notices readable on the card', () => {
    expect(ratio(parseColor(card['--err-fg']), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps short cards (find ID, forgot password …) at the login card size with the form centered', () => {
    const card = block(/\n\s*\.auth-split__card\s*\{/);
    expect(card).toMatch(/min-height:\s*37rem/);
    expect(card).toMatch(/flex-direction:\s*column/);
    const body = block(/\n\s*\.auth-split__body\s*\{/);
    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/justify-content:\s*center/);
  });

  it('fills and sweeps a light streak across the submit and demo buttons on hover, but not when reduced motion is preferred', () => {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const button of [
      "\n.auth-split button[type='submit'][data-slot='button']",
      "\n.auth-split .auth-split__demo[data-slot='button']",
    ]) {
      const fill = block(new RegExp(`${escape(button)}:hover[^{]*\\{`));
      expect(fill).toMatch(/background:\s*var\(--primary-solid\)/);
      const streak = block(new RegExp(`${escape(button)}::after[^{]*\\{`));
      expect(streak).toMatch(/transition:\s*left/);
      expect(css).toMatch(new RegExp(`${escape(button)}:hover::after`));
    }
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*::after\s*\{\s*transition:\s*none;/);
  });

  it('flips the card in, but not when reduced motion is preferred', () => {
    expect(block(/\n\s*\.auth-split__card\s*\{/)).toMatch(/animation:\s*auth-card-flip-in/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.auth-split__card\s*\{\s*animation:\s*none;/,
    );
  });
});

// 인증 화면 배경색이 html 바탕과 달라 스크롤바 자리가 흰 띠로 남지 않게 한다
describe('auth pages scrollbar', () => {
  it('hides the page scrollbar and its reserved gutter while an auth page is shown', () => {
    const rule = block(/\nhtml:has\(\.auth-split\)\s*\{/);
    expect(rule).toMatch(/scrollbar-gutter:\s*auto/);
    expect(rule).toMatch(/scrollbar-width:\s*none/);
    expect(block(/\nhtml:has\(\.auth-split\)::-webkit-scrollbar\s*\{/)).toMatch(/display:\s*none/);
  });
});

// 의료진 화면(장비 검색·마이페이지) — .staff(.staff-tokens)에 라이트 토큰, html.dark 쪽에 다크 토큰
describe('staff screen tokens', () => {
  const staffLight = tokens(block(/\n\.staff,\s*\.staff-tokens\s*\{/));
  const staffDark = { ...staffLight, ...tokens(block(/html\.dark \.staff,\s*html\.dark \.staff-tokens\s*\{/)) };

  const pairs: [string, string, number][] = [
    ['--staff-text', '--staff-surface', 4.5],
    ['--staff-muted', '--staff-surface', 4.5],
    ['--staff-muted', '--staff-canvas', 4.5],
    ['--staff-muted', '--staff-fill', 4.5],
    ['--staff-teal-text', '--staff-surface', 4.5],
    ['--staff-teal-text', '--staff-fill', 4.5],
    ['--staff-danger-text', '--staff-surface', 4.5],
    ['--staff-alert-text', '--staff-fill', 4.5],
  ];

  it.each(pairs)('light %s on %s stays readable (≥ %s:1)', (fg, bg, min) => {
    expect(ratio(parseColor(staffLight[fg]), parseColor(staffLight[bg]))).toBeGreaterThanOrEqual(min);
  });

  it.each(pairs)('dark %s on %s stays readable (≥ %s:1)', (fg, bg, min) => {
    expect(ratio(parseColor(staffDark[fg]), parseColor(staffDark[bg]))).toBeGreaterThanOrEqual(min);
  });

  // 확정·탈퇴 단추는 두 테마 모두 흰 글자
  it.each(['--staff-confirm', '--staff-danger'])('keeps white text readable on %s in both themes', (token) => {
    const white = parseColor('#ffffff');
    expect(ratio(white, parseColor(staffLight[token]))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(white, parseColor(staffDark[token]))).toBeGreaterThanOrEqual(4.5);
  });

  it('separates the panels from the page background in both themes', () => {
    expect(staffLight['--staff-surface']).not.toBe(staffLight['--staff-canvas']);
    expect(staffDark['--staff-surface']).not.toBe(staffDark['--staff-canvas']);
  });
});
