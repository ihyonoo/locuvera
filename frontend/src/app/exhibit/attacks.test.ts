import { afterEach, describe, expect, it, vi } from 'vitest';
import { type TermLine, USED_TAP, forgeIngest, replayNfc } from './attacks';

const TAG_ID = 'fda50693-a4e2-4fb1-afcf-c6eb07647825:1:002';

type Call = { url: string; init: RequestInit };

function liveResponse(readerId: string, location: string) {
  return new Response(
    JSON.stringify({
      items: [{ tag_id: TAG_ID, equipment_name: '수액펌프-001', reader_id: readerId, location }],
      readers: [
        { reader_id: 'M501', location: '중앙수술센터', is_real_hardware: true },
        { reader_id: 'M502', location: '통원수술센터', is_real_hardware: true },
        { reader_id: 'M101', location: '소아응급', is_real_hardware: false },
      ],
    }),
    { status: 200 },
  );
}

function reject(status: number, detail: string) {
  return new Response(JSON.stringify({ detail }), { status });
}

function run(attack: typeof forgeIngest, respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const lines: TermLine[] = [];
  const marks: string[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  });
  vi.stubGlobal('fetch', fetchMock);
  const done = attack({
    api: '/api',
    token: 'demo-token',
    print: (line) => lines.push(line),
    mark: (key) => marks.push(key),
    pause: async () => {},
    signal: new AbortController().signal,
  });
  return { calls, lines, marks, done };
}

const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);
const text = (lines: TermLine[]) => lines.map((line) => line.text).join('\n');

afterEach(() => vi.unstubAllGlobals());

describe('forgeIngest', () => {
  function respond(call: Call) {
    if (call.url.includes('/rtls/live')) return liveResponse('M502', '통원수술센터');
    if (header(call, 'X-RTLS-Reader-ID') === 'M999') return reject(403, '등록된 활성 리더가 아닙니다.');
    if (header(call, 'X-RTLS-Signature')) return reject(401, '리더 서명이 올바르지 않습니다.');
    return reject(401, '리더 인증 정보가 올바르지 않습니다.');
  }

  it('sends three forged reports that claim the real beacon moved to the other real reader', async () => {
    const { calls, done } = run(forgeIngest, respond);
    await done;

    const posts = calls.filter((call) => call.url === '/api/ingest');
    expect(posts).toHaveLength(3);
    for (const post of posts) {
      const body = JSON.parse(post.init.body as string);
      expect(body.observations[0].tag_id).toBe(TAG_ID);
    }
    expect(header(posts[0], 'X-RTLS-Signature')).toBeNull();
    expect(JSON.parse(posts[0].init.body as string).reader_id).toBe('M501');
    expect(header(posts[1], 'X-RTLS-Reader-ID')).toBe('M501');
    expect(header(posts[1], 'X-RTLS-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(header(posts[1], 'X-RTLS-Nonce')).toMatch(/^[0-9a-f]{32}$/);
    expect(header(posts[2], 'X-RTLS-Reader-ID')).toBe('M999');
  });

  it('reads the live position with the session token before and after the attack', async () => {
    const { calls, done } = run(forgeIngest, respond);
    await done;

    const reads = calls.filter((call) => call.url.includes('/rtls/live'));
    expect(reads).toHaveLength(2);
    expect(header(reads[0], 'Authorization')).toBe('Bearer demo-token');
  });

  it('prints every rejection and the unchanged position', async () => {
    const { lines, done } = run(forgeIngest, respond);
    await done;

    const out = text(lines);
    expect(out).toContain('401 리더 인증 정보가 올바르지 않습니다. · 차단');
    expect(out).toContain('401 리더 서명이 올바르지 않습니다. · 차단');
    expect(out).toContain('403 등록된 활성 리더가 아닙니다. · 차단');
    expect(out).toContain('위조 보고 3건 중 3건 차단');
    expect(out).toContain('수액펌프-001 · 통원수술센터 (변화 없음)');
    expect(lines.filter((line) => line.tone === 'bad')).toHaveLength(0);
  });

  it('points at the code of each step as it runs', async () => {
    const { marks, done } = run(forgeIngest, respond);
    await done;

    expect(marks).toEqual([
      'forge-report-0',
      'forge-send',
      'forge-report-1',
      'forge-sign',
      'forge-send',
      'forge-report-2',
      'forge-send',
    ]);
  });

  it('flags a report that the server accepted', async () => {
    const { lines, done } = run(forgeIngest, (call) =>
      call.url.includes('/rtls/live') ? liveResponse('M502', '통원수술센터') : new Response('{}', { status: 200 }),
    );
    await done;

    expect(lines.filter((line) => line.tone === 'bad').length).toBeGreaterThan(0);
  });
});

describe('replayNfc', () => {
  it('replays the used tap and a counter-bumped copy with the old CMAC', async () => {
    const { calls, lines, done } = run(replayNfc, () => reject(403, '유효하지 않은 NFC 태그 인증입니다.'));
    await done;

    expect(calls.map((call) => call.url)).toEqual([
      `/api/nfc/${USED_TAP.token}?uid=${USED_TAP.uid}&ctr=${USED_TAP.ctr}&cmac=${USED_TAP.cmac}`,
      `/api/nfc/${USED_TAP.token}?uid=${USED_TAP.uid}&ctr=00000B&cmac=${USED_TAP.cmac}`,
    ]);
    expect(header(calls[0], 'Authorization')).toBe('Bearer demo-token');
    expect(text(lines)).toContain('공격 2건 중 2건 차단');
  });

  it('points at the code of each step as it runs', async () => {
    const { marks, done } = run(replayNfc, () => reject(403, '유효하지 않은 NFC 태그 인증입니다.'));
    await done;

    expect(marks).toEqual(['replay-attempt-0', 'replay-send', 'replay-attempt-1', 'replay-bump', 'replay-send']);
  });
});
