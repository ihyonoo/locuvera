import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import NfcMapping from './NfcMapping';

const DEMO_NOTICE = '데모 체험 계정에서는 NFC 매핑을 변경할 수 없습니다.';

function storeAdminSession(isDemo: boolean, canManageNfc: boolean | undefined = true) {
  sessionStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: 'test-token',
      expires_at: 9999999999,
      user: {
        user_id: 1,
        username: 'admin',
        display_name: '관리자',
        role: 'admin',
        is_demo: isDemo,
        can_manage_nfc: canManageNfc,
      },
    }),
  );
}

const MAPPING_PAYLOAD = {
  ok: true,
  items: [
    {
      tag_id: 'EQ-0001',
      equipment_name: '제세동기-001',
      equipment_type: '제세동기',
      nfc_token: 'defib-001',
      asset_status: 'available',
      is_active: true,
      is_real_hardware: true,
      reader_id: 'M101',
      location: '1층 병동 A',
      updated_at: null,
      is_stale: false,
    },
  ],
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/admin/nfc-mapping']}>
      <Routes>
        <Route path="/admin/nfc-mapping" element={<NfcMapping />} />
      </Routes>
    </MemoryRouter>,
  );
}

// 사이드바 검색 필터에도 같은 placeholder가 있어, id가 없는 목록 카드 쪽 입력을 고른다.
function tokenInputOfFirstItem() {
  const inputs = screen.getAllByPlaceholderText('예: defib-001');
  return inputs.find((input) => !input.id) as HTMLElement;
}

async function renderAndWait() {
  renderPage();
  await screen.findByText('제세동기-001');
  // 목록 조회 호출은 이미 끝났으므로, 이후 호출 여부만으로 쓰기 요청을 판별한다.
  return vi.mocked(fetch).mock.calls.length;
}

describe('NfcMapping demo guards', () => {
  beforeEach(() => {
    sessionStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => MAPPING_PAYLOAD }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('warns instead of saving a mapping', async () => {
    storeAdminSession(true);
    const callsBefore = await renderAndWait();

    fireEvent.change(tokenInputOfFirstItem(), { target: { value: 'defib-002' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });

  it('warns instead of removing a mapping', async () => {
    storeAdminSession(true);
    const callsBefore = await renderAndWait();

    fireEvent.click(screen.getByRole('button', { name: '매핑 해제' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });

  it('still saves a mapping for a normal admin', async () => {
    storeAdminSession(false);
    const callsBefore = await renderAndWait();

    fireEvent.change(tokenInputOfFirstItem(), { target: { value: 'defib-002' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(callsBefore));
    expect(screen.queryByText(DEMO_NOTICE)).not.toBeInTheDocument();
  });

  it('shows a disabled-looking action and administrator guidance for an unapproved admin', async () => {
    storeAdminSession(false, false);
    const callsBefore = await renderAndWait();
    const saveButton = screen.getByRole('button', { name: '저장' });
    expect(saveButton).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(saveButton);
    expect(await screen.findByText('NFC 매핑 변경 권한은 시스템 관리자에게 문의하세요.')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });

  it('refreshes an old session capability before allowing a grandfathered admin to edit', async () => {
    storeAdminSession(false, undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            String(url).includes('/auth/me') ? { ok: true, user: { can_manage_nfc: true } } : MAPPING_PAYLOAD,
        }),
      ),
    );
    await renderAndWait();

    await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toHaveAttribute('aria-disabled', 'false'));
    expect(JSON.parse(sessionStorage.getItem('auth_session') ?? '{}').user.can_manage_nfc).toBe(true);
  });

  it('refreshes a cached capability when it was revoked', async () => {
    storeAdminSession(false, true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            String(url).includes('/auth/me') ? { ok: true, user: { can_manage_nfc: false } } : MAPPING_PAYLOAD,
        }),
      ),
    );
    await renderAndWait();

    await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toHaveAttribute('aria-disabled', 'true'));
    expect(JSON.parse(sessionStorage.getItem('auth_session') ?? '{}').user.can_manage_nfc).toBe(false);
  });

  it('refreshes a cached capability when it was granted', async () => {
    storeAdminSession(false, false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            String(url).includes('/auth/me') ? { ok: true, user: { can_manage_nfc: true } } : MAPPING_PAYLOAD,
        }),
      ),
    );
    await renderAndWait();

    await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toHaveAttribute('aria-disabled', 'false'));
    expect(JSON.parse(sessionStorage.getItem('auth_session') ?? '{}').user.can_manage_nfc).toBe(true);
  });

  it('keeps the session when the server rejects a mapping write', async () => {
    storeAdminSession(false);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, options?: RequestInit) =>
        Promise.resolve({
          ok: options?.method !== 'POST',
          status: options?.method === 'POST' ? 403 : 200,
          json: async () => (options?.method === 'POST' ? { detail: '금지' } : MAPPING_PAYLOAD),
        }),
      ),
    );
    await renderAndWait();
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    expect(await screen.findByText('NFC 매핑 변경 권한은 시스템 관리자에게 문의하세요.')).toBeInTheDocument();
    expect(sessionStorage.getItem('auth_session')).not.toBeNull();
    expect(JSON.parse(sessionStorage.getItem('auth_session') ?? '{}').user.can_manage_nfc).toBe(false);
  });
});
