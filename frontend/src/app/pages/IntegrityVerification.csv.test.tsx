import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import IntegrityVerification from './IntegrityVerification';

function storeAdminSession() {
  sessionStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: 'test-token',
      expires_at: 9999999999,
      user: { user_id: 1, username: 'admin', display_name: '관리자', role: 'admin' },
    }),
  );
}

const TAG_ID = 'a83f2c9e-6b1d-4e2a-9c77-51f8d20b6a44:2:015';

function buildItem(overrides: Record<string, unknown> = {}) {
  return {
    usage_id: 42,
    user: { name: '박수현', position: '수간호사', department: '응급의학과' },
    returned_by: { name: '김도윤', position: '전공의', department: '정형외과' },
    equipment: { tag_id: TAG_ID, name: '검체이송 카트 7호' },
    checkout: { reader_id: 'M101', location: '1층 병동 A', at: 1_700_000_000 },
    return: { reader_id: 'M503', location: '수술실', at: 1_700_003_600 },
    movement_path: [
      { location: '복도 B', at: 1_700_001_000 },
      { location: '영상의학과', at: 1_700_002_000 },
    ],
    blockchain: {
      verification_status: 'verified',
      verification_label: '무결성 검증 성공',
      db_record: null,
      tx_input_matches_db: true,
      transactions_root_matches: true,
      anchor: null,
    },
    ...overrides,
  };
}

const LIVE_PAYLOAD = { ok: true, readers: [] };

let requestedUrls: string[] = [];
let blobs: Blob[] = [];

function mockFetch(items: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      requestedUrls.push(String(url));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          String(url).includes('/rtls/live')
            ? LIVE_PAYLOAD
            : { ok: true, total: items.length, count: items.length, items },
      });
    }),
  );
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/verification']}>
      <Routes>
        <Route path="/verification" element={<IntegrityVerification />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function downloadCsv() {
  const button = await screen.findByRole('button', { name: 'CSV 다운로드' });
  fireEvent.click(button);
  await waitFor(() => expect(blobs).toHaveLength(1));
  return (await blobs[0].text()).replace(/^\ufeff/, '').split('\r\n');
}

/** CSV 요청만 골라낸다 — 화면 조회 요청과 구분해야 파라미터를 확인할 수 있다. */
function csvRequestUrls() {
  return requestedUrls.filter((url) => url.includes('limit=200'));
}

function csvRequestUrl() {
  return csvRequestUrls().at(-1) ?? '';
}

/** 응답 시점을 직접 잡아, 내보내는 도중의 화면을 관찰할 수 있게 한다. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('IntegrityVerification CSV progress modal', () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeAdminSession();
    requestedUrls = [];
    blobs = [];
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        blobs.push(blob);
        return 'blob:test';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** CSV 응답 두 개를 순서대로 내가 풀어준다. 화면(limit!=200) 요청은 즉시 응답한다. */
  function stubStagedCsv() {
    const gates = [deferred<unknown>(), deferred<unknown>()];
    let csvCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const text = String(url);
        requestedUrls.push(text);
        if (text.includes('/rtls/live')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => LIVE_PAYLOAD });
        }
        if (text.includes('limit=200')) {
          const gate = gates[csvCalls];
          csvCalls += 1;
          return gate.promise.then((payload) => ({ ok: true, status: 200, json: async () => payload }));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, total: 250, count: 1, items: [buildItem()] }),
        });
      }),
    );
    return gates;
  }

  async function startExport() {
    const button = await screen.findByRole('button', { name: 'CSV 다운로드' });
    fireEvent.click(button);
    return button;
  }

  it('opens a progress modal as soon as the export starts', async () => {
    stubStagedCsv();
    renderPage();
    await startExport();

    const modal = within(await screen.findByRole('dialog'));
    expect(modal.getByText('CSV를 준비하는 중입니다')).toBeInTheDocument();
  });

  it('counts up as each chunk arrives', async () => {
    const gates = stubStagedCsv();
    renderPage();
    await startExport();
    await screen.findByRole('dialog');

    gates[0].resolve({
      ok: true,
      total: 250,
      count: 200,
      items: Array.from({ length: 200 }, (_, i) => buildItem({ usage_id: 1000 - i })),
    });

    const modal = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(modal.getByText('250건 중 200건 내려받았습니다')).toBeInTheDocument());
  });

  it('keeps the download button disabled while the export runs', async () => {
    const gates = stubStagedCsv();
    renderPage();
    const button = await startExport();
    await screen.findByRole('dialog');

    expect(button).toBeDisabled();

    gates[0].resolve({ ok: true, total: 1, count: 1, items: [buildItem()] });
    await waitFor(() => expect(blobs).toHaveLength(1));
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('closes the modal once the file is handed over', async () => {
    const gates = stubStagedCsv();
    renderPage();
    await startExport();
    await screen.findByRole('dialog');

    gates[0].resolve({ ok: true, total: 1, count: 1, items: [buildItem()] });

    await waitFor(() => expect(blobs).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes the modal and surfaces the error when the export fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const text = String(url);
        requestedUrls.push(text);
        if (text.includes('/rtls/live')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => LIVE_PAYLOAD });
        }
        if (text.includes('limit=200')) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ detail: '체인이 응답하지 않습니다.' }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, total: 1, count: 1, items: [buildItem()] }),
        });
      }),
    );
    renderPage();
    await startExport();

    await screen.findByText('체인이 응답하지 않습니다.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(blobs).toHaveLength(0);
  });
});

describe('IntegrityVerification CSV export', () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeAdminSession();
    requestedUrls = [];
    blobs = [];
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        blobs.push(blob);
        return 'blob:test';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    mockFetch([buildItem()]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exports the agreed column set', async () => {
    renderPage();

    const [header] = await downloadCsv();
    expect(header.split(',')).toEqual([
      '사용 이력 ID',
      '장비명',
      '대여자 정보',
      '반납자 정보',
      '대여 위치',
      '반납 위치',
      '대여 시각',
      '반납 시각',
      '이동 경로',
      '무결성 검증 결과',
    ]);
  });

  // 이름·부서·직책이 한 칸에 들어간다.
  it('packs each handler into a single cell', async () => {
    renderPage();

    const [, row] = await downloadCsv();
    expect(row).toContain('박수현 · 응급의학과 · 수간호사');
    expect(row).toContain('김도윤 · 정형외과 · 전공의');
  });

  it('neutralizes formula-like text, including leading whitespace and control characters', async () => {
    mockFetch([
      buildItem({
        equipment: { tag_id: TAG_ID, name: '\t=1+1' },
        checkout: { reader_id: 'M101', location: '  @SUM(1)', at: 1_700_000_000 },
        user: { name: '+cmd', position: '수간호사', department: '응급의학과' },
      }),
    ]);
    renderPage();

    const [, row] = await downloadCsv();
    expect(row).toContain("'\t=1+1");
    expect(row).toContain("'  @SUM(1)");
    expect(row).toContain("'+cmd · 응급의학과 · 수간호사");
  });

  it('writes the locations, movement path and timestamps', async () => {
    renderPage();

    const [, row] = await downloadCsv();
    expect(row).toContain('1층 병동 A');
    expect(row).toContain('수술실');
    expect(row).toContain('복도 B → 영상의학과');
    expect(row).toMatch(/2023년 \d{2}월 \d{2}일/);
  });

  it('reduces the verification status to 성공 or 실패', async () => {
    renderPage();

    const [, verified] = await downloadCsv();
    expect(verified.endsWith('성공')).toBe(true);

    blobs = [];
    mockFetch([
      buildItem({
        blockchain: {
          verification_status: 'db_mismatch',
          verification_label: 'DB/온체인 원문 불일치',
          db_record: null,
          tx_input_matches_db: null,
          transactions_root_matches: null,
          anchor: null,
        },
      }),
    ]);
    const [, tampered] = await downloadCsv();
    expect(tampered.endsWith('실패')).toBe(true);
  });

  it('asks the server for the on-chain verification the CSV needs', async () => {
    renderPage();

    await downloadCsv();
    expect(csvRequestUrl()).toContain('include_blockchain=true');
  });

  // 화면 total은 사용 중인 이력까지 세므로, 그 수를 채우려고 빈 페이지를 더 받으면 안 된다.
  it('stops fetching once the CSV total is reached', async () => {
    let csvCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const text = String(url);
        requestedUrls.push(text);
        if (text.includes('/rtls/live')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => LIVE_PAYLOAD });
        }
        if (text.includes('limit=200')) {
          csvCalls += 1;
          // CSV 대상은 1건뿐 — 두 번째 요청부터는 빈 페이지다.
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, total: 1, count: 1, items: csvCalls === 1 ? [buildItem()] : [] }),
          });
        }
        // 화면은 사용 중인 이력까지 세어 5건이라고 알려준다.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, total: 5, count: 1, items: [buildItem()] }),
        });
      }),
    );

    renderPage();
    await downloadCsv();

    expect(csvCalls).toBe(1);
  });

  // 백엔드는 검증을 켜면 limit을 200으로 자른다. 요청한 수가 아니라 받은 수만큼 전진해야
  // 201번째부터가 통째로 누락되지 않는다.
  it('advances the offset by the rows the server actually returned', async () => {
    const pages = [
      Array.from({ length: 200 }, (_, i) => buildItem({ usage_id: 1000 - i })),
      Array.from({ length: 50 }, (_, i) => buildItem({ usage_id: 800 - i })),
    ];
    let csvCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const text = String(url);
        requestedUrls.push(text);
        if (text.includes('/rtls/live')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => LIVE_PAYLOAD });
        }
        if (text.includes('limit=200')) {
          const items = pages[csvCalls] ?? [];
          csvCalls += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, total: 250, count: items.length, items }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, total: 250, count: 1, items: [buildItem()] }),
        });
      }),
    );

    renderPage();
    const lines = await downloadCsv();

    const urls = csvRequestUrls();
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=200');
    // 헤더 1줄 + 250건
    expect(lines).toHaveLength(251);
  });

  // 사용 중인 이력은 검증 대상이 아니라 CSV에 넣지 않는다 — 화면 체크와 무관하게 항상 제외한다.
  it('always leaves out in-use records, even when the screen includes them', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('checkbox', { name: /사용 중인 이력 포함/ }));
    await downloadCsv();

    expect(csvRequestUrl()).toContain('include_in_use=false');
  });
});
