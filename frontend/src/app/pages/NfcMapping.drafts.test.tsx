import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import NfcMapping from './NfcMapping';

const items = [
  {
    tag_id: 'tag-1',
    equipment_name: '제세동기-001',
    equipment_type: '제세동기',
    nfc_token: 'defib-001',
    asset_status: 'available',
    is_active: true,
    is_real_hardware: true,
    created_at: 1756000000,
    ntag_uid: null,
    ntag_bound: false,
    ntag_last_ctr: 0,
  },
  {
    tag_id: 'tag-2',
    equipment_name: '수액펌프-002',
    equipment_type: '수액펌프',
    nfc_token: 'pump-002',
    asset_status: 'available',
    is_active: true,
    is_real_hardware: true,
    created_at: 1756000000,
    ntag_uid: null,
    ntag_bound: false,
    ntag_last_ctr: 0,
  },
];

function cardFor(name: string) {
  return screen.getByText(name).closest('section') as HTMLElement;
}

describe('NfcMapping drafts', () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(
      'auth_session',
      JSON.stringify({
        token: 'test-token',
        expires_at: 9999999999,
        user: { user_id: 1, username: 'admin', display_name: '관리자', role: 'admin', can_manage_nfc: true },
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, items }) }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('preserves another row draft after saving one mapping', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/nfc-mapping']}>
        <Routes>
          <Route path="/admin/nfc-mapping" element={<NfcMapping />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('제세동기-001');
    fireEvent.change(within(cardFor('제세동기-001')).getByPlaceholderText('예: defib-001'), {
      target: { value: 'defib-009' },
    });
    fireEvent.change(within(cardFor('수액펌프-002')).getByPlaceholderText('예: defib-001'), {
      target: { value: 'pump-009' },
    });
    fireEvent.click(within(cardFor('제세동기-001')).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(within(cardFor('수액펌프-002')).getByPlaceholderText('예: defib-001')).toHaveValue('pump-009');
  });
});
