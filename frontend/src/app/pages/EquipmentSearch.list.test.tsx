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

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/equipment']}>
      <Routes>
        <Route path="/equipment" element={<EquipmentSearch />} />
      </Routes>
    </MemoryRouter>,
  );
}

function sidebar() {
  return screen.getByTestId('equipment-sidebar');
}

function floorTabs() {
  return screen.getByTestId('floor-tabs');
}

async function openListView() {
  renderPage();
  await screen.findByTestId('floor-map-container');
  fireEvent.click(screen.getByRole('button', { name: '목록' }));
}

function stubLiveFetch() {
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
}

describe('EquipmentSearch list view floor tabs', () => {
  beforeEach(stubLiveFetch);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows per-floor tabs without an 전체 option', async () => {
    await openListView();

    expect(within(floorTabs()).getByRole('button', { name: '1층' })).toBeInTheDocument();
    expect(within(floorTabs()).getByRole('button', { name: '5층' })).toBeInTheDocument();
    expect(within(floorTabs()).queryByRole('button', { name: '전체' })).not.toBeInTheDocument();
  });

  it('keeps only the selected floor zone cards', async () => {
    await openListView();

    expect(screen.getByRole('heading', { name: '1층 병동 A' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '2층 응급실' })).not.toBeInTheDocument();

    fireEvent.click(within(floorTabs()).getByRole('button', { name: '2층' }));

    expect(screen.getByRole('heading', { name: '2층 응급실' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '1층 병동 A' })).not.toBeInTheDocument();
  });

  it('shares the selected floor with the map view', async () => {
    await openListView();

    fireEvent.click(within(floorTabs()).getByRole('button', { name: '2층' }));
    fireEvent.click(screen.getByRole('button', { name: '지도' }));

    expect(await screen.findByRole('img', { name: '2층 평면도' })).toBeInTheDocument();
  });

  it('does not narrow the sidebar equipment list', async () => {
    await openListView();

    // 층 탭은 본문 구역 카드만 좁힌다 — 사이드바 목록은 전 층을 그대로 보여준다.
    fireEvent.click(within(floorTabs()).getByRole('button', { name: '2층' }));

    expect(within(sidebar()).getByText('수액펌프 1호')).toBeInTheDocument();
    expect(within(sidebar()).getByText('제세동기 1호')).toBeInTheDocument();
  });

  it('narrows only the sidebar list when the sidebar 층 select changes', async () => {
    await openListView();

    fireEvent.click(within(sidebar()).getByLabelText('층'));
    fireEvent.click(await screen.findByRole('option', { name: '2층' }));

    await waitFor(() => expect(within(sidebar()).queryByText('수액펌프 1호')).not.toBeInTheDocument());
    expect(within(sidebar()).getByText('제세동기 1호')).toBeInTheDocument();
    // 본문 구역 카드는 여전히 층 탭(1층) 기준이다.
    expect(screen.getByRole('heading', { name: '1층 병동 A' })).toBeInTheDocument();
  });
});

describe('EquipmentSearch sidebar filters', () => {
  beforeEach(stubLiveFetch);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lays the two filter toggles out on one row', async () => {
    renderPage();
    await screen.findByTestId('floor-map-container');

    const toggles = screen.getByTestId('equipment-filter-toggles');
    expect(toggles).toHaveClass('staff-switches');
    expect(within(toggles).getByLabelText('사용 가능만')).toBeInTheDocument();
    expect(within(toggles).getByLabelText('시뮬레이션 숨김')).toBeInTheDocument();
  });

  it('reports the full count when no filter is active', async () => {
    renderPage();
    await screen.findByTestId('floor-map-container');

    const summary = screen.getByTestId('equipment-result-summary');
    expect(summary).toHaveTextContent('전체 3건');
    expect(summary).not.toHaveTextContent('검색 결과');
  });

  it('marks the list as a search result and lists the active conditions', async () => {
    renderPage();
    await screen.findByTestId('floor-map-container');

    fireEvent.change(within(sidebar()).getByPlaceholderText('태그 ID, 장비명, 위치 검색'), {
      target: { value: '수액' },
    });
    fireEvent.click(within(sidebar()).getByLabelText('사용 가능만'));

    const summary = screen.getByTestId('equipment-result-summary');
    await waitFor(() => expect(summary).toHaveTextContent('검색 결과 1건'));
    expect(summary).toHaveTextContent('"수액"');
    expect(summary).toHaveTextContent('사용 가능만');
  });

  it('keeps the summary visible when nothing matches', async () => {
    renderPage();
    await screen.findByTestId('floor-map-container');

    fireEvent.change(within(sidebar()).getByPlaceholderText('태그 ID, 장비명, 위치 검색'), {
      target: { value: '없는장비' },
    });

    await waitFor(() => expect(screen.getByTestId('equipment-result-summary')).toHaveTextContent('검색 결과 0건'));
    expect(within(sidebar()).getByText('조건에 맞는 장비가 없습니다.')).toBeInTheDocument();
  });
});

describe('EquipmentSearch list view zones', () => {
  beforeEach(stubLiveFetch);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('labels the floor buttons 1F~5F while keeping 층 names for screen readers', async () => {
    await openListView();

    expect(within(floorTabs()).getByRole('button', { name: '1층' })).toHaveTextContent('1F');
    expect(within(floorTabs()).getByRole('button', { name: '5층' })).toHaveTextContent('5F');
  });

  it('says a zone has no equipment right now when nothing is there', async () => {
    await openListView();

    fireEvent.change(within(sidebar()).getByPlaceholderText('태그 ID, 장비명, 위치 검색'), {
      target: { value: '제세동기' },
    });

    const zone = screen.getByRole('heading', { name: '1층 병동 A' }).closest('section') as HTMLElement;
    await waitFor(() => expect(within(zone).getByText('현재 장비 없음')).toBeInTheDocument());
  });
});
