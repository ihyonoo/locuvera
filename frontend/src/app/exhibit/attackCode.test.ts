import { describe, expect, it } from 'vitest';
import { ATTACK_SOURCE, CODE_EXCERPTS, CODE_MARKS, highlightLine, markedLines } from './attackCode';

describe('attack code shown beside the live attacks', () => {
  it('shows the real source of attacks.ts', () => {
    expect(ATTACK_SOURCE).toContain('export const forgeIngest');
    expect(ATTACK_SOURCE).toContain('export const replayNfc');
  });

  it('cuts one excerpt per attack with the real file line numbers', () => {
    const lines = ATTACK_SOURCE.split('\n');
    for (const excerpt of Object.values(CODE_EXCERPTS)) {
      expect(excerpt.lines.length).toBeGreaterThan(10);
      expect(lines[excerpt.firstLine - 1]).toBe(excerpt.lines[0]);
    }
    expect(CODE_EXCERPTS['forge-ingest'].lines.join('\n')).toContain('export async function buildForgedReports');
    expect(CODE_EXCERPTS['replay-nfc'].lines.join('\n')).toContain('export function buildReplayUrls');
  });

  it('shows only the attack code, not the code that drives the screen', () => {
    for (const excerpt of Object.values(CODE_EXCERPTS)) {
      expect(excerpt.lines.join('\n')).not.toMatch(/ctx\.(print|pause|mark)/);
    }
  });

  it('finds every highlight inside the excerpt of its attack', () => {
    for (const [mark, range] of Object.entries(CODE_MARKS)) {
      const excerpt = CODE_EXCERPTS[range.attack];
      const lines = markedLines(mark as keyof typeof CODE_MARKS);
      expect(lines.length, mark).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, mark).toBeGreaterThanOrEqual(excerpt.firstLine);
        expect(line, mark).toBeLessThan(excerpt.firstLine + excerpt.lines.length);
      }
    }
  });

  it('highlights the HMAC signing with the attacker key', () => {
    const signing = markedLines('forge-sign').map((line) => ATTACK_SOURCE.split('\n')[line - 1]);
    expect(signing.join('\n')).toContain('hmacSha256Hex(attackerKey');
  });

  it('colors keywords, strings and comments', () => {
    const tokens = highlightLine("  const key = 'abc'; // 임의 키");
    expect(tokens).toEqual([
      { text: '  ' },
      { text: 'const', kind: 'keyword' },
      { text: ' key = ' },
      { text: "'abc'", kind: 'string' },
      { text: '; ' },
      { text: '// 임의 키', kind: 'comment' },
    ]);
  });
});
