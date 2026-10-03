import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

function makeItem(index: number) {
  const label = String(index).padStart(2, '0');
  return {
    usage_id: index,
    user: { name: '박수현', position: '간호사', department: '응급의학과' },
    returned_by: { name: '박수현', position: '간호사', department: '응급의학과' },
    equipment: { tag_id: `EQ-00${label}`, name: `장비 ${label}`, is_real_hardware: true },
    checkout: { reader_id: 'M101', location: '1층 병동 A', at: 1_700_000_000 },
    return: { reader_id: 'M101', location: '1층 병동 A', at: 1_700_003_600 },
    blockchain: {
      verification_status: 'verified',
      verification_label: '검증 성공',
      db_record: null,
      tx_input_matches_db: true,
      transactions_root_matches: true,
      anchor: {
        block_number: 100 + index,
        transaction_index: 0,
        transactions_root: '0xroot',
        recalculated_transactions_root: '0xroot',
      },
    },
  };
}

const TOTAL = 25;

const LIVE_PAYLOAD = {
  ok: true,
  readers: [{ reader_id: 'M101', location: '1층 병동 A', is_online: true, last_seen: 0, floor: 1 }],
};

/** 서버처럼 limit/offset을 실제로 잘라 돌려주는 mock. */
function historyPayloadFor(url: string) {
  const params = new URL(url, 'http://localhost').searchParams;
  const limit = Number(params.get('limit') ?? '10');
  const offset = Number(params.get('offset') ?? '0');
  const all = Array.from({ length: TOTAL }, (_, i) => makeItem(i + 1));
  const slice = all.slice(offset, offset + limit);
  return { ok: true, count: slice.length, total: TOTAL, offset, items: slice };
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

function visibleEquipmentNames() {
  return screen.getAllByText(/^장비 \d{2}$/);
}

function historyRequests() {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/usage/history'));
}

describe('IntegrityVerification server-side pagination', () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeAdminSession();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (String(url).includes('/rtls/live') ? LIVE_PAYLOAD : historyPayloadFor(String(url))),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the server for one page at a time instead of everything at once', async () => {
    renderPage();

    await screen.findByText('장비 01');
    const [firstRequest] = historyRequests();
    expect(firstRequest).toContain('limit=10');
    expect(firstRequest).toContain('offset=0');
    expect(visibleEquipmentNames()).toHaveLength(10);
  });

  it('counts pages from the server total, not from the rows on screen', async () => {
    renderPage();

    await screen.findByText('장비 01');
    expect(screen.getByText('25건 중 1–10건')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3페이지' })).toBeInTheDocument();
  });

  it('refetches with a new offset when the page changes', async () => {
    renderPage();

    await screen.findByText('장비 01');
    fireEvent.click(screen.getByRole('button', { name: '3페이지' }));

    await waitFor(() => expect(screen.getByText('장비 21')).toBeInTheDocument());
    expect(historyRequests().some((url) => url.includes('offset=20'))).toBe(true);
    expect(screen.queryByText('장비 01')).not.toBeInTheDocument();
  });

  it('refetches from the first page when the page size changes', async () => {
    renderPage();

    await screen.findByText('장비 01');
    fireEvent.click(screen.getByRole('combobox', { name: '페이지당 개수' }));
    fireEvent.click(await screen.findByRole('option', { name: '50개씩' }));

    await waitFor(() => expect(visibleEquipmentNames()).toHaveLength(25));
    const last = historyRequests().at(-1) ?? '';
    expect(last).toContain('limit=50');
    expect(last).toContain('offset=0');
  });

  it('returns to the first page when a new search is submitted', async () => {
    renderPage();

    await screen.findByText('장비 01');
    fireEvent.click(screen.getByRole('button', { name: '3페이지' }));
    await waitFor(() => expect(screen.getByText('장비 21')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '조회' }));

    await waitFor(() => expect(screen.getByText('장비 01')).toBeInTheDocument());
    expect(historyRequests().at(-1)).toContain('offset=0');
  });

  it('ignores a slow response from an older page request', async () => {
    let releaseSlow!: (value: unknown) => void;
    const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('offset=20')) return slow;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (String(url).includes('/rtls/live') ? LIVE_PAYLOAD : historyPayloadFor(String(url))),
        });
      }),
    );
    renderPage();
    await screen.findByText('장비 01');

    fireEvent.click(screen.getByRole('button', { name: '3페이지' }));
    await waitFor(() => expect(historyRequests().some((url) => url.includes('offset=20'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '2페이지' }));
    await screen.findByText('장비 11');
    await act(async () => {
      releaseSlow({
        ok: true,
        status: 200,
        json: async () => historyPayloadFor('http://localhost/usage/history?limit=10&offset=20'),
      });
    });

    await waitFor(() => expect(screen.getByText('장비 11')).toBeInTheDocument());
    expect(screen.queryByText('장비 21')).not.toBeInTheDocument();
  });
});
