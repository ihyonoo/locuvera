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

const HISTORY_PAYLOAD = { ok: true, count: 0, items: [] };
const LIVE_PAYLOAD = {
  ok: true,
  readers: [{ reader_id: 'M101', location: '1층 병동 A', is_online: true, last_seen: 0, floor: 1 }],
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/verification']}>
      <Routes>
        <Route path="/verification" element={<IntegrityVerification />} />
      </Routes>
    </MemoryRouter>,
  );
}

function sidebar() {
  return screen.getByTestId('verification-sidebar');
}

describe('IntegrityVerification search sidebar', () => {
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
          json: async () => (String(url).includes('/rtls/live') ? LIVE_PAYLOAD : HISTORY_PAYLOAD),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the search fields inside the left sidebar instead of above the results', async () => {
    renderPage();

    const panel = within(await screen.findByTestId('verification-sidebar'));
    expect(panel.getByText('검색 조건')).toBeInTheDocument();
    expect(panel.getByPlaceholderText('이름, 사용자 ID')).toBeInTheDocument();
    expect(panel.getByPlaceholderText('장비명 또는 태그 ID')).toBeInTheDocument();
  });

  it('keeps all four search actions inside the sidebar', async () => {
    renderPage();

    const panel = within(await screen.findByTestId('verification-sidebar'));
    ['조회', '새로고침', '초기화', 'CSV 다운로드'].forEach((label) => {
      expect(panel.getByRole('button', { name: label })).toBeInTheDocument();
    });
  });

  // 기간만 비우는 버튼은 '초기화'와 기능이 겹쳐 걷어냈다.
  it('no longer offers a separate date-range reset', async () => {
    renderPage();

    const panel = within(await screen.findByTestId('verification-sidebar'));
    expect(panel.queryByRole('button', { name: '기간 초기화' })).not.toBeInTheDocument();
  });

  // 버튼 줄을 패널 바닥에 고정하면 사이드바가 짧을 때 필드와 멀어진다 — 마지막 필드에 이어 붙인다.
  it('attaches the action row directly below the last condition field', async () => {
    renderPage();

    const panel = await screen.findByTestId('verification-sidebar');
    const submit = within(panel).getByRole('button', { name: '조회' });
    const lastField = within(panel).getByText('정렬 방향');

    // compareDocumentPosition: PRECEDING(2)이면 마지막 필드가 조회 버튼보다 앞선다.
    expect(submit.compareDocumentPosition(lastField) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    // 버튼이 스크롤되는 필드 영역 안에 있어야 필드와 같은 흐름에 놓인다.
    expect(submit.closest('.overflow-y-auto')).not.toBeNull();
  });

  it('leaves the usage history results outside the sidebar', async () => {
    renderPage();

    await screen.findByTestId('verification-sidebar');
    expect(screen.getByText('의료 장비 사용 이력')).toBeInTheDocument();
    expect(within(sidebar()).queryByText('의료 장비 사용 이력')).not.toBeInTheDocument();
  });

  it('still submits the search from the sidebar', async () => {
    renderPage();

    await screen.findByTestId('verification-sidebar');
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();

    fireEvent.change(within(sidebar()).getByPlaceholderText('이름, 사용자 ID'), { target: { value: '박수현' } });
    fireEvent.click(within(sidebar()).getByRole('button', { name: '조회' }));

    await waitFor(() => {
      const requested = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(
        requested.some((url) => url.includes('/usage/history') && url.includes(encodeURIComponent('박수현'))),
      ).toBe(true);
    });
  });
});
