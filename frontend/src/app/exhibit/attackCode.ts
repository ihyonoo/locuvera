// 라이브 실연 옆 코드 창: 지금 브라우저가 실행하는 attacks.ts 원문을 그대로 보여 준다
// 강조 범위는 줄 번호가 아니라 코드 조각으로 찾는다 — 코드를 고쳐도 따라가고, 조각이 사라지면 테스트가 깨진다
import attackSource from './attacks.ts?raw';
import type { AttackKind, CodeMark } from './attacks';

export const ATTACK_SOURCE: string = attackSource;
export const ATTACK_SOURCE_PATH = 'frontend/src/app/exhibit/attacks.ts';

const SOURCE_LINES = ATTACK_SOURCE.split('\n');

// 1부터 세는 줄 번호. after 이후 처음 나오는 줄
function lineOf(snippet: string, after = 1): number {
  const index = SOURCE_LINES.findIndex((line, i) => i + 1 >= after && line.includes(snippet));
  if (index < 0) throw new Error(`attacks.ts에서 코드 조각을 찾지 못함: ${snippet}`);
  return index + 1;
}

type ExcerptRange = { from: string; until: string };

const EXCERPT_RANGES: Record<AttackKind, ExcerptRange> = {
  'forge-ingest': { from: '// 위조 측위 보고 3건', until: '// NFC 재전송 2건' },
  'replay-nfc': { from: '// NFC 재전송 2건', until: '// ━━ 실연 진행' },
};

export type CodeExcerpt = { firstLine: number; lines: string[] };

function cut({ from, until }: ExcerptRange): CodeExcerpt {
  const first = lineOf(from);
  let last = lineOf(until, first + 1) - 1;
  while (last > first && SOURCE_LINES[last - 1].trim() === '') last -= 1;
  return { firstLine: first, lines: SOURCE_LINES.slice(first - 1, last) };
}

export const CODE_EXCERPTS: Record<AttackKind, CodeExcerpt> = {
  'forge-ingest': cut(EXCERPT_RANGES['forge-ingest']),
  'replay-nfc': cut(EXCERPT_RANGES['replay-nfc']),
};

// from 줄부터 그 뒤 처음 나오는 to 줄까지
export const CODE_MARKS: Record<CodeMark, { attack: AttackKind; from: string; to?: string }> = {
  'forge-report-0': {
    attack: 'forge-ingest',
    from: "head: '[1] 서명 없는 보고'",
    to: "headers: { 'Content-Type': 'application/json' }",
  },
  'forge-report-1': {
    attack: 'forge-ingest',
    from: "head: '[2] 위조 서명'",
    to: 'headers: await sign(readerId, claimed)',
  },
  'forge-report-2': {
    attack: 'forge-ingest',
    from: "head: '[3] 미등록 리더'",
    to: 'headers: await sign(UNREGISTERED_READER, unknown)',
  },
  'forge-sign': {
    attack: 'forge-ingest',
    from: 'const attackerKey = crypto.getRandomValues',
    to: 'hmacSha256Hex(attackerKey',
  },
  'forge-send': {
    attack: 'forge-ingest',
    from: 'export function sendForgedReport',
    to: 'return fetch(`${api}/ingest`',
  },
  'replay-attempt-0': { attack: 'replay-nfc', from: "head: '[1] 재전송'", to: 'query(USED_TAP.ctr)' },
  'replay-attempt-1': { attack: 'replay-nfc', from: "head: '[2] 복제 URL 위조'", to: 'query(forgedCtr)' },
  'replay-bump': { attack: 'replay-nfc', from: 'const nextCounter =' },
  'replay-send': { attack: 'replay-nfc', from: 'export function sendTap', to: 'return fetch(url' },
};

export function markedLines(mark: CodeMark): number[] {
  const { attack, from, to } = CODE_MARKS[mark];
  const start = lineOf(from, CODE_EXCERPTS[attack].firstLine);
  const end = to ? lineOf(to, start) : start;
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export type CodeToken = { text: string; kind?: 'keyword' | 'string' | 'comment' | 'number' };

const TOKEN =
  /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(const|let|await|async|return|if|for|of|in|new|export|type|as|true|false|null|undefined)\b|\b(\d+)\b/g;

// 편집기처럼 키워드·문자열·주석·숫자만 칠한다
export function highlightLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ text: line.slice(last, index) });
    const kind = match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'keyword' : 'number';
    tokens.push({ text: match[0], kind });
    last = index + match[0].length;
  }
  if (last < line.length) tokens.push({ text: line.slice(last) });
  return tokens;
}
