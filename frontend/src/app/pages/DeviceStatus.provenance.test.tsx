import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import DeviceStatus from './DeviceStatus';

function storeAdminSession() {
  sessionStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: 'test-token',
      expires_at: 9999999999,
      user: { user_id: 1, username: 'u', display_name: 'u', role: 'admin' },
    }),
  );
}

const LIVE_PAYLOAD = {
  ok: true,
  count: 2,
  ts: 0,
  items: [
    {
      tag_id: 'EQ-REAL',
      equipment_name: '실물 장비',
      reader_id: 'M501',
      location: '수술실',
      is_online: true,
      last_seen: 0,
      is_real_hardware: true,
    },
    {
      tag_id: 'EQ-SIM',
      equipment_name: '모의 장비',
      reader_id: 'M101',
      location: '병동 A',
      is_online: true,
      last_seen: 0,
      is_real_hardware: false,
    },
  ],
  readers: [
    { reader_id: 'M501', location: '수술실', is_online: true, last_seen: 0, is_real_hardware: true },
    { reader_id: 'M101', location: '병동 A', is_online: true, last_seen: 0, is_real_hardware: false },
  ],
  readers_online: 2,
  readers_total: 2,
  tags_online: 2,
  tags_total: 2,
};

describe('DeviceStatus provenance visibility', () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeAdminSession();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => LIVE_PAYLOAD }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks simulated rows with a provenance dot but not real hardware rows', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/devices']}>
        <Routes>
          <Route path="/admin/devices" element={<DeviceStatus />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('모의 장비');
    const dots = screen.getAllByTestId('provenance-dot');
    expect(dots).toHaveLength(2); // M101 리더 1개 + EQ-SIM 태그 1개
  });

  it('hides simulated readers and tags when the toggle is switched on', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/devices']}>
        <Routes>
          <Route path="/admin/devices" element={<DeviceStatus />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('모의 장비');
    fireEvent.click(screen.getByRole('checkbox', { name: '시뮬레이션 데이터 숨기기' }));

    expect(screen.queryByText('모의 장비')).not.toBeInTheDocument();
    expect(screen.getByText('실물 장비')).toBeInTheDocument();
    expect(screen.getAllByText('1 / 1')).toHaveLength(2);
  });
});
