import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

function makeItem(index: number) {
  const label = String(index).padStart(2, '0');
  return {
    tag_id: `EQ-00${label}`,
    equipment_name: `장비 ${label}`,
    equipment_type: '수액펌프',
    nfc_token: null,
    asset_status: 'available',
    is_active: true,
    reader_id: 'M101',
    location: '1층 병동 A',
    updated_at: null,
    is_stale: false,
  };
}

const MAPPING_PAYLOAD = { ok: true, items: Array.from({ length: 25 }, (_, i) => makeItem(i + 1)) };

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/admin/nfc-mapping']}>
      <Routes>
        <Route path="/admin/nfc-mapping" element={<NfcMapping />} />
      </Routes>
    </MemoryRouter>,
  );
}

function visibleEquipmentNames() {
  return screen.getAllByText(/^장비 \d{2}$/);
}

describe('NfcMapping pagination', () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeAdminSession();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => MAPPING_PAYLOAD,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows only the first page of equipment by default', async () => {
    renderPage();

    await screen.findByText('장비 01');
    expect(visibleEquipmentNames()).toHaveLength(10);
    expect(screen.getByRole('combobox', { name: '페이지당 개수' })).toHaveTextContent('10개씩');
    expect(screen.queryByText('장비 11')).not.toBeInTheDocument();
  });

  it('shows the remaining equipment on the last page', async () => {
    renderPage();

    await screen.findByText('장비 01');
    fireEvent.click(screen.getByRole('button', { name: '3페이지' }));

    expect(visibleEquipmentNames()).toHaveLength(5);
    expect(screen.getByText('장비 21')).toBeInTheDocument();
  });

  it('applies the page size the admin picked', async () => {
    renderPage();

    await screen.findByText('장비 01');
    fireEvent.click(screen.getByRole('combobox', { name: '페이지당 개수' }));
    fireEvent.click(await screen.findByRole('option', { name: '50개씩' }));

    await waitFor(() => expect(visibleEquipmentNames()).toHaveLength(25));
  });

  it('returns to the first page when the search query changes', async () => {
    renderPage();

    await screen.findByText('장비 01');
    fireEvent.click(screen.getByRole('button', { name: '3페이지' }));
    expect(screen.queryByText('장비 01')).not.toBeInTheDocument();

    const sidebar = within(screen.getByTestId('nfc-mapping-sidebar'));
    fireEvent.change(sidebar.getByLabelText('장비명'), { target: { value: '장비 0' } });
    fireEvent.click(sidebar.getByRole('button', { name: '검색' }));

    await waitFor(() => expect(screen.getByText('장비 01')).toBeInTheDocument());
  });
});
