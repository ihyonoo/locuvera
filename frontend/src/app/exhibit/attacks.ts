// 전시 순환 중 운영 서버로 실제로 보내는 보안 실연(tools/exhibit의 forge_ingest·replay_nfc와 같은 요청)
// 모두 서버가 거부하는 요청이라 데이터는 바뀌지 않는다 — NFC 거부만 감사 기록(usage_nfc_events)에 1행씩 남는다
// 올바른 리더 키로 서명한 요청은 보내지 않는다
// 위쪽 '공격 코드' 구역이 전시 화면 옆 코드 창에 그대로 보인다(attackCode.ts). 화면 진행은 아래 '실연 진행' 구역에 둔다

export type TermLine = { text: string; tone?: 'title' | 'dim' | 'head' | 'good' | 'bad' };

// 옆 코드 창에서 지금 실행 중인 부분을 강조한다(attackCode.ts의 CODE_MARKS)
export type CodeMark =
  | 'forge-report-0'
  | 'forge-report-1'
  | 'forge-report-2'
  | 'forge-sign'
  | 'forge-send'
  | 'replay-attempt-0'
  | 'replay-attempt-1'
  | 'replay-bump'
  | 'replay-send';

export type AttackContext = {
  api: string;
  token: string | null;
  print: (line: TermLine) => void;
  mark?: (mark: CodeMark) => void;
  pause: (ms: number) => Promise<void>;
  signal: AbortSignal;
};

export type Attack = (ctx: AttackContext) => Promise<void>;

const REAL_EQUIPMENT = '수액펌프-001';
const UNREGISTERED_READER = 'M999';
// 리더 바로 옆에 있는 것처럼 센 신호
const FORGED_RSSI = -35;
// 2026-11-09 폰으로 태깅해 이미 쓰인 URL(운영 칩 카운터 10 이상) — 다시 보내면 카운터 재사용으로 거부된다
export const USED_TAP = { token: 'pump-001', uid: '04B07F1A8F1E90', ctr: '00000A', cmac: '668E29F6B822438F' };

const hex = (buffer: ArrayBuffer | Uint8Array) =>
  Array.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

async function hmacSha256Hex(key: Uint8Array<ArrayBuffer>, message: string) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)));
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ━━ 공격 코드 ━━

// 위조 측위 보고 3건 — 실물 장비가 다른 리더 구역에 있다고 거짓 보고
export async function buildForgedReports(readerId: string, tagId: string, now: number) {
  const body = (reporter: string) =>
    JSON.stringify({
      reader_id: reporter,
      ts: now,
      observations: [{ tag_id: tagId, rssi: FORGED_RSSI, count: 5, last_seen: now }],
    });
  // 공격자는 리더 키를 모른다 — 매번 새로 만든 임의 키로 서명한다
  const attackerKey = crypto.getRandomValues(new Uint8Array(32));
  const sign = async (reporter: string, payload: string) => {
    const nonce = randomHex(16);
    const bodyHash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)));
    return {
      'Content-Type': 'application/json',
      'X-RTLS-Reader-ID': reporter,
      'X-RTLS-Timestamp': String(now),
      'X-RTLS-Nonce': nonce,
      'X-RTLS-Signature': await hmacSha256Hex(attackerKey, `v1\n${reporter}\n${now}\n${nonce}\n${bodyHash}`),
    };
  };
  const claimed = body(readerId);
  const unknown = body(UNREGISTERED_READER);
  return [
    {
      head: '[1] 서명 없는 보고',
      explain: `서명 헤더 없이 리더 ${readerId} 명의로 전송`,
      mark: 'forge-report-0' as const,
      body: claimed,
      headers: { 'Content-Type': 'application/json' } as Record<string, string>,
    },
    {
      head: '[2] 위조 서명',
      explain: `등록된 리더 ${readerId} 사칭 · 리더 키 대신 임의 키로 HMAC 서명`,
      mark: 'forge-report-1' as const,
      showSigning: true,
      body: claimed,
      headers: await sign(readerId, claimed),
    },
    {
      head: '[3] 미등록 리더',
      explain: `미등록 리더 ${UNREGISTERED_READER} 명의로 서명·전송`,
      mark: 'forge-report-2' as const,
      body: unknown,
      headers: await sign(UNREGISTERED_READER, unknown),
    },
  ];
}

export function sendForgedReport(
  api: string,
  report: { body: string; headers: Record<string, string> },
  signal: AbortSignal,
) {
  return fetch(`${api}/ingest`, { method: 'POST', headers: report.headers, body: report.body, signal });
}

// NFC 재전송 2건 — 이미 쓴 태깅 URL 그대로, 카운터만 올리고 CMAC은 그대로
const nextCounter = (ctr: string) => (parseInt(ctr, 16) + 1).toString(16).toUpperCase().padStart(ctr.length, '0');

export function buildReplayUrls(api: string) {
  const query = (ctr: string) => `uid=${USED_TAP.uid}&ctr=${ctr}&cmac=${USED_TAP.cmac}`;
  const forgedCtr = nextCounter(USED_TAP.ctr);
  return [
    {
      head: '[1] 재전송',
      explain: `이미 한 번 쓰인 태깅 URL(카운터 ${USED_TAP.ctr})을 그대로 다시 전송`,
      mark: 'replay-attempt-0' as const,
      url: `${api}/nfc/${USED_TAP.token}?${query(USED_TAP.ctr)}`,
    },
    {
      head: '[2] 복제 URL 위조',
      explain: `카운터만 ${USED_TAP.ctr} → ${forgedCtr}로 올리고 CMAC은 그대로 둔 URL`,
      mark: 'replay-attempt-1' as const,
      bumpsCounter: true,
      url: `${api}/nfc/${USED_TAP.token}?${query(forgedCtr)}`,
    },
  ];
}

export function sendTap(url: string, token: string | null, signal: AbortSignal) {
  return fetch(url, { headers: authHeaders(token), signal });
}

// ━━ 실연 진행 ━━ 터미널 패널 출력과 읽을 시간. 코드 창에는 보이지 않는다

// 읽을 수 있게 단락 머리와 판정 앞에서 쉰다
const HEAD_PAUSE_MS = 1300;
const VERDICT_PAUSE_MS = 800;
// 코드 창에서 강조한 줄을 읽을 시간
const CODE_PAUSE_MS = 1000;

// 화면에 보이는 주소는 절대 주소로
const shownUrl = (api: string, path: string) => new URL(`${api}${path}`, window.location.origin).href;

async function detailOf(response: Response) {
  const payload = await response.json().catch(() => null);
  return typeof payload?.detail === 'string' ? payload.detail : response.statusText;
}

type LiveItem = { tag_id: string; equipment_name: string; reader_id: string | null; location: string | null };
type LiveReader = { reader_id: string; location: string | null; is_real_hardware?: boolean };

async function readLive(ctx: AttackContext) {
  const response = await fetch(`${ctx.api}/rtls/live?hide_simulated=true`, {
    headers: authHeaders(ctx.token),
    signal: ctx.signal,
  });
  if (!response.ok) throw new Error(`실시간 위치 조회 실패(${response.status})`);
  const live = (await response.json()) as { items?: LiveItem[]; readers?: LiveReader[] };
  const tag = live.items?.find((item) => item.equipment_name === REAL_EQUIPMENT);
  const readers = (live.readers ?? []).filter((reader) => reader.is_real_hardware);
  return { tag, readers };
}

async function verdict(ctx: AttackContext, response: Response, acceptedLabel: string) {
  await ctx.pause(VERDICT_PAUSE_MS);
  if (response.status >= 400) {
    ctx.print({ text: `    → ${response.status} ${await detailOf(response)} · 차단`, tone: 'good' });
    return true;
  }
  ctx.print({ text: `    → ${response.status} ${acceptedLabel} · 차단 실패`, tone: 'bad' });
  return false;
}

async function showStep(ctx: AttackContext, step: { head: string; explain: string; mark: CodeMark }) {
  await ctx.pause(HEAD_PAUSE_MS);
  ctx.print({ text: '' });
  ctx.print({ text: step.head, tone: 'head' });
  ctx.print({ text: `    ${step.explain}`, tone: 'dim' });
  ctx.mark?.(step.mark);
  await ctx.pause(CODE_PAUSE_MS);
}

async function showCode(ctx: AttackContext, mark: CodeMark) {
  ctx.mark?.(mark);
  await ctx.pause(CODE_PAUSE_MS);
}

export const forgeIngest: Attack = async (ctx) => {
  ctx.print({ text: '━━ 측위 보고 위조 차단 ━━', tone: 'title' });
  ctx.print({ text: `대상 ${shownUrl(ctx.api, '/ingest')}`, tone: 'dim' });
  const before = await readLive(ctx);
  if (!before.tag || before.readers.length === 0) {
    ctx.print({ text: '실물 장비·리더를 찾지 못해 실연을 건너뜀', tone: 'bad' });
    return;
  }
  const tag = before.tag;
  // 받아들여지면 장비가 옮겨 가 보일 리더 — 지금 위치가 아닌 실물 리더
  const target = before.readers.find((reader) => reader.reader_id !== tag.reader_id) ?? before.readers[0];
  ctx.print({ text: `    현재 위치  ${REAL_EQUIPMENT} · ${tag.location ?? '미확인'}` });
  ctx.print({ text: `    공격 목표  ${target.location}(${target.reader_id}) 위치 거짓 보고` });

  const reports = await buildForgedReports(target.reader_id, tag.tag_id, Math.floor(Date.now() / 1000));
  let blocked = 0;
  for (const report of reports) {
    await showStep(ctx, report);
    if ('showSigning' in report) await showCode(ctx, 'forge-sign');
    ctx.mark?.('forge-send');
    if (await verdict(ctx, await sendForgedReport(ctx.api, report, ctx.signal), '수락됨')) blocked += 1;
  }

  const after = await readLive(ctx);
  const moved = after.tag?.reader_id !== tag.reader_id;
  await ctx.pause(HEAD_PAUSE_MS);
  ctx.print({ text: '' });
  ctx.print({ text: `    결과  위조 보고 ${reports.length}건 중 ${blocked}건 차단` });
  ctx.print({
    text: `    현재 위치  ${REAL_EQUIPMENT} · ${after.tag?.location ?? '미확인'} (${moved ? '변경됨' : '변화 없음'})`,
    tone: moved ? 'bad' : undefined,
  });
};

export const replayNfc: Attack = async (ctx) => {
  ctx.print({ text: '━━ NFC 태그 복제·재전송 차단 ━━', tone: 'title' });
  ctx.print({ text: `대상 ${shownUrl(ctx.api, `/nfc/${USED_TAP.token}`)}`, tone: 'dim' });
  const attempts = buildReplayUrls(ctx.api);
  let blocked = 0;
  for (const attempt of attempts) {
    await showStep(ctx, attempt);
    if ('bumpsCounter' in attempt) await showCode(ctx, 'replay-bump');
    ctx.mark?.('replay-send');
    if (await verdict(ctx, await sendTap(attempt.url, ctx.token, ctx.signal), '태깅 세션 발급')) blocked += 1;
  }

  await ctx.pause(HEAD_PAUSE_MS);
  ctx.print({ text: '' });
  ctx.print({ text: `    결과  공격 ${attempts.length}건 중 ${blocked}건 차단` });
  ctx.print({
    text: '    거부 사유(카운터 재사용·CMAC 불일치)는 응답에 드러내지 않고 서버 감사 기록에만 저장',
    tone: 'dim',
  });
};

export const ATTACKS = { 'forge-ingest': forgeIngest, 'replay-nfc': replayNfc } as const;
export type AttackKind = keyof typeof ATTACKS;
