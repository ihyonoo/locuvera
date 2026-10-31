import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
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

function stub() {
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
}

describe('IntegrityVerification on a narrow (mobile) viewport', () => {
  beforeEach(() => {
    stub();
    setViewportWidth(375);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setViewportWidth(1440);
  });

  it('replaces the boxed sidebar with an 상세검색 toggle that starts closed', async () => {
    renderPage();
    await screen.findByText('의료 장비 사용 이력');

    expect(screen.queryByTestId('verification-sidebar')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('이름, 사용자 ID')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '상세검색' })).toBeInTheDocument();
  });

  it('reveals the search fields and actions when 상세검색 is opened, and hides them again on a second click', async () => {
    renderPage();
    await screen.findByText('의료 장비 사용 이력');

    fireEvent.click(screen.getByRole('button', { name: '상세검색' }));

    expect(screen.getByPlaceholderText('이름, 사용자 ID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '조회' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '상세검색' }));

    expect(screen.queryByPlaceholderText('이름, 사용자 ID')).not.toBeInTheDocument();
  });

  it('still leaves the usage history results visible without opening 상세검색', async () => {
    renderPage();

    expect(await screen.findByText('의료 장비 사용 이력')).toBeInTheDocument();
  });
});

describe('IntegrityVerification on a wide (desktop) viewport', () => {
  beforeEach(() => {
    stub();
    setViewportWidth(1440);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the boxed sidebar and does not render the 상세검색 toggle', async () => {
    renderPage();
    await screen.findByText('의료 장비 사용 이력');

    expect(screen.getByTestId('verification-sidebar')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '상세검색' })).not.toBeInTheDocument();
  });
});
