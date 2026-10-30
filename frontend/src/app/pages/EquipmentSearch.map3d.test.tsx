import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import EquipmentSearch from './EquipmentSearch';

// three.js는 jsdom에서 돌지 않으므로 3D 지도는 받은 props만 드러내는 가짜로 바꾼다
const fake = vi.hoisted(() => ({ throwOnRender: false }));
vi.mock('../components/floor3d/FloorMap3D', () => ({
  default: (props: { floor: number; onUnavailable: () => void }) => {
    if (fake.throwOnRender) throw new Error('3d crashed');
    return (
      <div data-testid="floor-map-3d" data-floor={props.floor}>
        <button type="button" onClick={props.onUnavailable}>
          simulate-context-lost
        </button>
      </div>
    );
  },
}));

const webgl = vi.hoisted(() => ({ available: true }));
vi.mock('../lib/mapDimension', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/mapDimension')>()),
  isWebGLAvailable: () => webgl.available,
}));

vi.mock('../lib/floorZoneBounds', () => ({
  ZONE_BOUNDS: {
    M101: [
      { x: 20, y: 40 },
      { x: 30, y: 40 },
      { x: 30, y: 60 },
      { x: 20, y: 60 },
    ],
  },
}));

const LIVE_PAYLOAD = {
  ok: true,
  count: 1,
  ts: 0,
  items: [
    {
      tag_id: 'EQ-0001',
      equipment_name: '수액펌프-002',
      equipment_type: '수액펌프',
      asset_status: 'available',
      current_holder_user_id: null,
      current_holder_name: null,
      reader_id: 'M101',
      location: '소아전문응급의료센터',
      rssi: -55,
      updated_at: 0,
      is_stale: false,
      is_online: true,
      last_seen: 0,
    },
  ],
  readers: [{ reader_id: 'M101', location: '소아전문응급의료센터', is_online: true, last_seen: 0, floor: 1 }],
  readers_online: 1,
  readers_total: 1,
  tags_online: 1,
  tags_total: 1,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/equipment']}>
      <Routes>
        <Route path="/equipment" element={<EquipmentSearch />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EquipmentSearch 3d floor map', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    sessionStorage.setItem(
      'auth_session',
      JSON.stringify({
        token: 'test-token',
        expires_at: 9999999999,
        user: { user_id: 1, username: 'u', display_name: 'u', role: 'staff' },
      }),
    );
    webgl.available = true;
    fake.throwOnRender = false;
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => LIVE_PAYLOAD }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens the 3d map when WebGL is available', async () => {
    renderPage();
    expect(await screen.findByTestId('floor-map-3d')).toHaveAttribute('data-floor', '1');
    expect(screen.queryByTestId('floor-map-container')).not.toBeInTheDocument();
  });

  it('switches to the 2d map only for this visit and opens in 3d again next time', async () => {
    const first = renderPage();
    await screen.findByTestId('floor-map-3d');
    fireEvent.click(screen.getByRole('button', { name: '2D' }));
    expect(await screen.findByTestId('floor-map-container')).toBeInTheDocument();

    first.unmount();
    renderPage();
    expect(await screen.findByTestId('floor-map-3d')).toBeInTheDocument();
    expect(screen.queryByTestId('floor-map-container')).not.toBeInTheDocument();
  });

  it('opens in 3d even when an earlier version remembered 2d', async () => {
    localStorage.setItem('locuvera.mapDimension', '2d');
    renderPage();
    expect(await screen.findByTestId('floor-map-3d')).toBeInTheDocument();
  });

  it('opens 2d and disables the 3d button without WebGL', async () => {
    webgl.available = false;
    renderPage();
    expect(await screen.findByTestId('floor-map-container')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D' })).toBeDisabled();
  });

  it('falls back to 2d with a notice when the 3d map becomes unavailable', async () => {
    renderPage();
    await screen.findByTestId('floor-map-3d');
    fireEvent.click(screen.getByRole('button', { name: 'simulate-context-lost' }));
    expect(await screen.findByTestId('floor-map-container')).toBeInTheDocument();
    expect(screen.getByText('3D 보기를 불러오지 못해 2D로 표시합니다.')).toBeInTheDocument();
  });

  it('falls back to 2d when the 3d map crashes while rendering', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.throwOnRender = true;
    renderPage();
    expect(await screen.findByTestId('floor-map-container')).toBeInTheDocument();
    expect(screen.getByText('3D 보기를 불러오지 못해 2D로 표시합니다.')).toBeInTheDocument();
  });
});
