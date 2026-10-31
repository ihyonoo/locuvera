import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import EquipmentSearch from './EquipmentSearch';

function storeStaffSession() {
  sessionStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: 'test-token',
      expires_at: 9999999999,
      user: { user_id: 1, username: 'u', display_name: 'u', role: 'staff' },
    }),
  );
}

// jsdom에는 scrollIntoView가 없어, Radix Select가 옵션 선택 시 이를 호출하면 렌더가 깨진다.
function mockScrollIntoView() {
  Element.prototype.scrollIntoView = vi.fn();
}

function mockContainerRect() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 1000,
    width: 1000,
    height: 1000,
    toJSON: () => {},
  });
}

const LIVE_PAYLOAD = {
  ok: true,
  count: 3,
  ts: 0,
  items: [
    {
      tag_id: 'EQ-0001',
      equipment_name: '수액펌프 1호',
      equipment_type: '수액펌프',
      asset_status: 'available',
      current_holder_user_id: null,
      current_holder_name: null,
      reader_id: 'M101',
      location: '1층 병동 A',
      rssi: -55,
      updated_at: 0,
      is_stale: false,
      is_online: true,
      last_seen: 0,
    },
    {
      tag_id: 'EQ-0002',
      equipment_name: '수액펌프 2호',
      equipment_type: '수액펌프',
      asset_status: 'checked_out',
      current_holder_user_id: 7,
      current_holder_name: '박수현',
      reader_id: 'M101',
      location: '1층 병동 A',
      rssi: -58,
      updated_at: 0,
      is_stale: false,
      is_online: true,
      last_seen: 0,
    },
    {
      tag_id: 'EQ-0003',
      equipment_name: '제세동기 1호',
      equipment_type: '제세동기',
      asset_status: 'available',
      current_holder_user_id: null,
      current_holder_name: null,
      reader_id: 'M201',
      location: '2층 응급실',
      rssi: -50,
      updated_at: 0,
      is_stale: false,
      is_online: true,
      last_seen: 0,
    },
  ],
  readers: [
    { reader_id: 'M101', location: '1층 병동 A', is_online: true, last_seen: 0, floor: 1 },
    { reader_id: 'M201', location: '2층 응급실', is_online: true, last_seen: 0, floor: 2 },
  ],
  readers_online: 2,
  readers_total: 2,
  tags_online: 3,
  tags_total: 3,
};

vi.mock('../lib/floorZoneBounds', () => ({
  ZONE_BOUNDS: {
    M101: [
      { x: 20, y: 40 },
      { x: 30, y: 40 },
      { x: 30, y: 60 },
      { x: 20, y: 60 },
    ],
    M201: [
      { x: 60, y: 40 },
      { x: 70, y: 40 },
      { x: 70, y: 60 },
      { x: 60, y: 60 },
    ],
  },
}));

describe('EquipmentSearch map view', () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeStaffSession();
    mockContainerRect();
    mockScrollIntoView();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => LIVE_PAYLOAD,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens on the map view without needing to switch tabs', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('floor-map-container')).toBeInTheDocument();
    expect(await screen.findByTestId('floor-map-equipment-EQ-0001')).toBeInTheDocument();
  });

  it('shows the equipment dot without drawing a zone marker', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('floor-map-equipment-EQ-0001')).toBeInTheDocument();
    // 직원 지도에는 구역 표식을 그리지 않는다 — 평면도에 이미 구역명이 인쇄돼 있다.
    expect(screen.queryByTestId('floor-map-pin-M101')).not.toBeInTheDocument();
  });

  it('colors the equipment dot by its asset status on the map', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId('floor-map-equipment-EQ-0001');
    expect(screen.getByTestId('floor-map-equipment-dot-EQ-0001')).toHaveClass('map-marker-ok');
    expect(screen.getByTestId('floor-map-equipment-dot-EQ-0002')).toHaveClass('map-marker-err');
  });

  it('hides checked-out equipment from the map when the available-only filter is on', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId('floor-map-equipment-EQ-0002');
    fireEvent.click(screen.getByRole('checkbox', { name: '사용 가능만' }));

    expect(screen.queryByTestId('floor-map-equipment-EQ-0002')).not.toBeInTheDocument();
    expect(screen.getByTestId('floor-map-equipment-EQ-0001')).toBeInTheDocument();
  });

  it('hides checked-out equipment from the list too when the available-only filter is on', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findAllByText('수액펌프 2호');
    fireEvent.click(screen.getByRole('checkbox', { name: '사용 가능만' }));

    expect(screen.queryByText('수액펌프 2호')).not.toBeInTheDocument();
    expect(screen.getAllByText('수액펌프 1호').length).toBeGreaterThan(0);
  });

  it('no longer shows the reader panel heading', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId('floor-map-container');
    expect(screen.queryByText('리더 위치 패널')).not.toBeInTheDocument();
  });

  function renderPage() {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  function sidebarItem(name: string) {
    return within(screen.getByTestId('equipment-sidebar')).getByText(name).closest('button') as HTMLElement;
  }

  it('drops the selection when a map dot is clicked — the map click only opens that dot label', async () => {
    renderPage();

    await screen.findAllByText('수액펌프 1호');
    fireEvent.click(sidebarItem('수액펌프 1호'));
    await waitFor(() => expect(sidebarItem('수액펌프 1호')).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(await screen.findByTestId('floor-map-equipment-EQ-0002'));

    await waitFor(() => expect(sidebarItem('수액펌프 1호')).toHaveAttribute('aria-pressed', 'false'));
    expect(sidebarItem('수액펌프 2호')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('floor-map-equipment-label-EQ-0002')).toBeInTheDocument();
  });

  it('shows the equipment name without its serial number on the map, and in full in the list', async () => {
    const item = { ...LIVE_PAYLOAD.items[1], equipment_name: '수액펌프-002' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ...LIVE_PAYLOAD, count: 1, items: [item] }),
      }),
    );
    renderPage();

    fireEvent.click(await screen.findByTestId('floor-map-equipment-EQ-0002'));
    expect(screen.getByTestId('floor-map-equipment-label-EQ-0002')).toHaveTextContent(/^수액펌프$/);
    expect(sidebarItem('수액펌프-002')).toBeInTheDocument();
  });

  it('toggles the selection off when the same sidebar item is clicked twice', async () => {
    renderPage();

    await screen.findAllByText('수액펌프 1호');
    fireEvent.click(sidebarItem('수액펌프 1호'));
    await waitFor(() => expect(sidebarItem('수액펌프 1호')).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(sidebarItem('수액펌프 1호'));

    await waitFor(() => expect(sidebarItem('수액펌프 1호')).toHaveAttribute('aria-pressed', 'false'));
  });

  it('drops the selection when the user switches to another floor', async () => {
    renderPage();

    await screen.findAllByText('수액펌프 1호');
    fireEvent.click(sidebarItem('수액펌프 1호'));
    await waitFor(() => expect(sidebarItem('수액펌프 1호')).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(screen.getByRole('button', { name: '2층' }));

    await waitFor(() => expect(sidebarItem('수액펌프 1호')).toHaveAttribute('aria-pressed', 'false'));
  });

  function getZoneGuidePanel() {
    return within(screen.getByTestId('zone-guide-panel'));
  }

  it('lists reader zones with their equipment count and amenities as plain text under the floor title', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId('floor-map-container');
    const zonePanel = getZoneGuidePanel();
    expect(zonePanel.getByRole('heading', { name: '1F' })).toBeInTheDocument();
    // 리더가 있는 구역(LIVE_PAYLOAD의 M101)은 대수와 함께 누를 수 있다
    expect(zonePanel.getByRole('button', { name: /1층 병동 A/ })).toHaveTextContent('2대');
    // 리더가 없는 편의시설(floorZones.ts)은 안내 글자만 — 누를 수 없다
    expect(zonePanel.getByText('GATE1')).toBeInTheDocument();
    expect(zonePanel.queryByRole('button', { name: /GATE1/ })).not.toBeInTheDocument();
  });

  it('filters the equipment list and highlights the map pin when a reader-backed zone is clicked', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId('floor-map-container');
    fireEvent.click(getZoneGuidePanel().getByRole('button', { name: /1층 병동 A/ }));

    const highlight = await screen.findByTestId('floor-map-highlight-M101');
    expect(highlight.style.left).not.toBe('');
    expect(Number.isNaN(parseFloat(highlight.style.left))).toBe(false);
    expect(screen.queryByText('수액펌프 1호')).toBeInTheDocument();
  });

  it('clears the highlight and the location filter when the same reader zone is clicked twice', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId('floor-map-container');
    const zoneButton = () => getZoneGuidePanel().getByRole('button', { name: /1층 병동 A/ });

    fireEvent.click(zoneButton());
    expect(await screen.findByTestId('floor-map-highlight-M101')).toBeInTheDocument();

    fireEvent.click(zoneButton());
    await waitFor(() => {
      expect(screen.queryByTestId('floor-map-highlight-M101')).not.toBeInTheDocument();
    });
    // 켤 때 같이 걸렸던 위치 필터도 함께 풀려, 다른 층 장비가 목록에 다시 보인다.
    expect(screen.getByText('제세동기 1호')).toBeInTheDocument();
  });

  it('switches the map to the floor of the equipment picked in the sidebar and blinks its marker', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByTestId('floor-map-container');
    // 지도는 1층으로 시작하므로 2층 장비(M201)의 마커는 아직 그려지지 않는다.
    expect(screen.queryByTestId('floor-map-equipment-EQ-0003')).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('equipment-sidebar')).getByText('제세동기 1호'));

    const dot = await screen.findByTestId('floor-map-equipment-dot-EQ-0003');
    expect(dot).toHaveClass('map-marker-spotlight');
    expect(screen.getByRole('img', { name: '2층 평면도' })).toBeInTheDocument();
  });

  it('narrows the location dropdown to the selected floor and filters the list by floor alone', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findAllByText('수액펌프 1호');
    expect(screen.getByText('제세동기 1호')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('combobox', { name: /층/ }));
    fireEvent.click(await screen.findByRole('option', { name: '2층' }));

    // 위치가 "전체"인 채로도 2층 장비만 남고 1층 장비는 사라진다.
    await waitFor(() => {
      expect(screen.queryByText('수액펌프 1호')).not.toBeInTheDocument();
    });
    expect(screen.getByText('제세동기 1호')).toBeInTheDocument();

    // 위치 드롭다운을 열면 1층 구역("1층 병동 A")은 더 이상 선택지에 없다.
    fireEvent.click(screen.getByRole('combobox', { name: /위치/ }));
    expect(screen.queryByRole('option', { name: '1층 병동 A' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: '2층 응급실' })).toBeInTheDocument();
  });
});
