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
    tag('a83f2c9e-6b1d-4e2a-9c77-51f8d20b6a44:2:004', '시린지펌프-001', 35),
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

  it('shows the reported battery level of each tag as a percentage', async () => {
    renderPage();

    expect(await screen.findByText('87%')).toBeInTheDocument();
  });

  it('draws a battery icon filled to the reported level', async () => {
    renderPage();

    const icon = (await screen.findByText('87%')).querySelector('svg.staff-battery');
    expect(icon).not.toBeNull();
    // 막대 최대 폭 14의 87%
    expect(Number(icon?.querySelector('[data-part="level"]')?.getAttribute('width'))).toBeCloseTo(12.18);
  });

  it('colors the level bar green, amber or red by the remaining charge', async () => {
    renderPage();

    const levelOf = async (text: string) => (await screen.findByText(text)).querySelector('[data-part="level"]');
    expect(await levelOf('87%')).toHaveClass('staff-battery__level--high');
    expect(await levelOf('35%')).toHaveClass('staff-battery__level--mid');
    expect(await levelOf('15%')).toHaveClass('staff-battery__level--low');
  });

  it('keeps the word battery for screen readers only', async () => {
    renderPage();

    await screen.findByText('87%');
    const words = screen.getAllByText(/배터리/);
    expect(words).toHaveLength(3);
    words.forEach((word) => expect(word).toHaveClass('sr-only'));
  });

  it('asks for a replacement in red to the left of the icon only below 20 percent', async () => {
    renderPage();

    const alerts = await screen.findAllByText('교체 필요');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveClass('staff-battery-alert');
    expect(alerts[0].nextElementSibling).toHaveClass('staff-battery');
    expect(alerts[0].parentElement).toBe(screen.getByText('15%'));
  });
});
