import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import DeviceStatus from './DeviceStatus';

const tag = (tagId: string, name: string, batteryPct: number | null) => ({
  tag_id: tagId,
  equipment_name: name,
  reader_id: 'M205',
  location: '주사센터',
  is_online: true,
  last_seen: 0,
  is_real_hardware: false,
  battery_pct: batteryPct,
});

const LIVE_PAYLOAD = {
  ok: true,
  count: 3,
  ts: 0,
  items: [
    tag('a83f2c9e-6b1d-4e2a-9c77-51f8d20b6a44:2:001', '수액펌프-002', 87),
    tag('a83f2c9e-6b1d-4e2a-9c77-51f8d20b6a44:2:002', '제세동기-001', 15),
    tag('a83f2c9e-6b1d-4e2a-9c77-51f8d20b6a44:2:003', '응급카트-001', null),
  ],
  readers: [],
  readers_online: 0,
  readers_total: 0,
  tags_online: 3,
  tags_total: 3,
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/admin/devices']}>
      <Routes>
        <Route path="/admin/devices" element={<DeviceStatus />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DeviceStatus beacon battery', () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(
      'auth_session',
      JSON.stringify({
        token: 'test-token',
        expires_at: 9999999999,
        user: { user_id: 1, username: 'u', display_name: 'u', role: 'admin' },
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => LIVE_PAYLOAD }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the reported battery level of each tag', async () => {
    renderPage();

    expect(await screen.findByText('배터리 87%')).toBeInTheDocument();
  });

  it('asks for a replacement below 20 percent', async () => {
    renderPage();

    const low = await screen.findByText('배터리 15% · 교체 필요');
    expect(low.querySelector('.staff-led--warn')).not.toBeNull();
    expect(screen.queryByText(/배터리 87% · 교체 필요/)).not.toBeInTheDocument();
  });

  it('leaves the battery line out when no level was reported', async () => {
    renderPage();

    await screen.findByText('배터리 87%');
    expect(screen.getAllByText(/^배터리/)).toHaveLength(2);
  });
});
