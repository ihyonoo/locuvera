import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import NfcMapping from './NfcMapping';

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

function itemFor(overrides: Record<string, unknown>) {
  return {
    tag_id: 'fda50693-a4e2-4fb1-afcf-c6eb07647825:1:2',
    equipment_name: '수액펌프-001',
    equipment_type: '인퓨전펌프',
    nfc_token: 'pump-001',
    asset_status: 'available',
    is_active: true,
    is_real_hardware: true,
    created_at: 1756000000,
    ntag_uid: null,
    ntag_bound: false,
    ntag_last_ctr: 0,
    ...overrides,
  };
}

function renderWith(items: Record<string, unknown>[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, items }) }));
  render(
    <MemoryRouter initialEntries={['/admin/nfc-mapping']}>
      <Routes>
        <Route path="/admin/nfc-mapping" element={<NfcMapping />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NfcMapping NTAG binding column', () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeAdminSession();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows which chip is attached and how many taps it has verified', async () => {
    renderWith([itemFor({ ntag_uid: '04B07F1A8F1E90', ntag_bound: true, ntag_last_ctr: 4 })]);

    expect(await screen.findByText(/04B07F1A8F1E90/)).toBeInTheDocument();
    // 카운터는 서버가 CMAC 검증에 성공했을 때만 오른다 — 실제로 쓰이는 태그인지 보여주는 값이다.
    expect(screen.getByText(/탭 4회/)).toBeInTheDocument();
  });

  it('marks equipment that has no chip bound yet', async () => {
    renderWith([itemFor({})]);

    expect(await screen.findByText('미바인딩')).toBeInTheDocument();
  });

  it('marks a tag whose binding was released, keeping it apart from never-bound', async () => {
    // 언바인딩은 UID를 지우지 않는다. 값이 남아 있다고 탭이 되는 것은 아니다.
    renderWith([itemFor({ ntag_uid: '04B07F1A8F1E90', ntag_bound: false, ntag_last_ctr: 9 })]);

    expect(await screen.findByText('미바인딩')).toBeInTheDocument();
  });

  it('encodes a legacy token before displaying its NFC URL', async () => {
    renderWith([itemFor({ nfc_token: 'pump%001' })]);

    expect(await screen.findByText(`${window.location.origin}/nfc/pump%25001`)).toBeInTheDocument();
  });

  it('no longer shows the RTLS snapshot, which belongs to the devices screen', async () => {
    renderWith([itemFor({ ntag_uid: '04B07F1A8F1E90', ntag_bound: true, ntag_last_ctr: 1 })]);

    await screen.findByText(/04B07F1A8F1E90/);
    expect(screen.queryByText(/현재 위치/)).not.toBeInTheDocument();
    expect(screen.queryByText(/최근 수신/)).not.toBeInTheDocument();
  });
});
