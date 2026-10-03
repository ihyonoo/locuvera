import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
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

function makeTag(tagId: string, name: string, readerId = 'M101') {
  return {
    tag_id: tagId,
    equipment_name: name,
    equipment_type: '수액펌프',
    asset_status: 'available',
    current_holder_user_id: null,
    current_holder_name: null,
    reader_id: readerId,
    location: readerId === 'M502' ? '통원수술센터' : '1층 병동 A',
    rssi: -55,
    updated_at: 0,
    is_stale: false,
    is_online: true,
    last_seen: 0,
  };
}

const REAL_TAG_ID = 'fda50693-a4e2-4fb1-afcf-c6eb07647825:1:2';
const SIM_TAG_ID = 'a83f2c9e-6b1d-4e2a-9c77-51f8d20b6a44:2:0010';

const SIM_READER = { reader_id: 'M101', location: '1층 병동 A', is_online: true, last_seen: 0, floor: 1 };
const REAL_READER = { reader_id: 'M502', location: '통원수술센터', is_online: true, last_seen: 0, floor: 5 };

/**
 * 서버를 흉내낸 mock. hide_simulated를 켜면 시뮬레이션 태그를 빼고, 리더에는 실물 여부를
 * 함께 실어준다(끄면 직원 응답이라 그 필드가 없다).
 */
function livePayloadFor(url: string) {
  const hideSimulated = new URL(url, 'http://localhost').searchParams.get('hide_simulated') === 'true';
  const items = hideSimulated
    ? [makeTag(REAL_TAG_ID, '실물 제세동기', 'M502')]
    : [makeTag(REAL_TAG_ID, '실물 제세동기', 'M502'), makeTag(SIM_TAG_ID, '모의 수액펌프', 'M101')];
  const readers = hideSimulated
    ? [
        { ...SIM_READER, is_real_hardware: false },
        { ...REAL_READER, is_real_hardware: true },
      ]
    : [SIM_READER, REAL_READER];
  return {
    ok: true,
    count: items.length,
    ts: 0,
    items,
    readers,
    readers_online: readers.length,
    readers_total: readers.length,
    tags_online: items.length,
    tags_total: items.length,
  };
}

vi.mock('../lib/floorZoneBounds', () => ({
  ZONE_BOUNDS: {
    M101: [
      { x: 20, y: 40 },
      { x: 30, y: 40 },
      { x: 30, y: 60 },
      { x: 20, y: 60 },
    ],
    M502: [
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
  return within(screen.getByTestId('equipment-sidebar'));
}

function liveRequests() {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.includes('/rtls/live'));
}

describe('EquipmentSearch simulated equipment toggle', () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeStaffSession();
    Element.prototype.scrollIntoView = vi.fn();
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
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve({ ok: true, status: 200, json: async () => livePayloadFor(String(url)) }),
        ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows every tracked item by default', async () => {
    renderPage();

    expect(await sidebar().findByText('실물 제세동기')).toBeInTheDocument();
    expect(sidebar().getByText('모의 수액펌프')).toBeInTheDocument();
  });

  it('asks the server to drop simulated equipment when the toggle is on', async () => {
    renderPage();

    await sidebar().findByText('모의 수액펌프');
    fireEvent.click(screen.getByRole('checkbox', { name: '시뮬레이션 장비 숨기기' }));

    await waitFor(() => expect(sidebar().queryByText('모의 수액펌프')).not.toBeInTheDocument());
    expect(liveRequests().at(-1)).toContain('hide_simulated=true');
    expect(sidebar().getByText('실물 제세동기')).toBeInTheDocument();
  });

  it('ignores an old live response after the simulation filter changes', async () => {
    let releaseOld!: (value: unknown) => void;
    const oldRequest = new Promise((resolve) => {
      releaseOld = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (!String(url).includes('hide_simulated=true')) return oldRequest;
        return Promise.resolve({ ok: true, status: 200, json: async () => livePayloadFor(String(url)) });
      }),
    );
    renderPage();
    await waitFor(() => expect(liveRequests()).toHaveLength(1));
    fireEvent.click(screen.getByRole('checkbox', { name: '시뮬레이션 장비 숨기기' }));
    await sidebar().findByText('실물 제세동기');
    await act(async () => {
      releaseOld({ ok: true, status: 200, json: async () => livePayloadFor('http://localhost/rtls/live') });
    });

    expect(sidebar().queryByText('모의 수액펌프')).not.toBeInTheDocument();
  });

  it('waits for a live request to finish before polling again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );
    renderPage();
    await waitFor(() => expect(liveRequests()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect(liveRequests()).toHaveLength(1);
  });

  it('leaves the map undimmed while the toggle is off', async () => {
    renderPage();

    await sidebar().findByText('모의 수액펌프');
    expect(screen.queryByTestId('floor-map-spotlight')).not.toBeInTheDocument();
  });

  it('dims every zone except the ones a real reader covers', async () => {
    renderPage();

    await sidebar().findByText('모의 수액펌프');
    fireEvent.click(screen.getByRole('checkbox', { name: '시뮬레이션 장비 숨기기' }));

    const spotlight = await screen.findByTestId('floor-map-spotlight');
    expect(within(spotlight).getByTestId('floor-map-spotlight-hole-M502')).toBeInTheDocument();
    expect(within(spotlight).queryByTestId('floor-map-spotlight-hole-M101')).not.toBeInTheDocument();
  });

  it('jumps to a floor that actually has real hardware when the toggle turns on', async () => {
    renderPage();

    await sidebar().findByText('모의 수액펌프');
    expect(screen.getByRole('img', { name: '1층 평면도' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: '시뮬레이션 장비 숨기기' }));

    // 실물 리더는 5층에만 있으므로, 1층에 머물러 빈 지도를 보여주지 않고 따라 올라간다.
    await waitFor(() => expect(screen.getByRole('img', { name: '5층 평면도' })).toBeInTheDocument());
  });

  it('stays put when the floor already has real hardware', async () => {
    renderPage();

    await sidebar().findByText('모의 수액펌프');
    fireEvent.click(screen.getByRole('checkbox', { name: '시뮬레이션 장비 숨기기' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '5층 평면도' })).toBeInTheDocument());

    // 이미 실물이 있는 층이면 토글을 다시 켜도 층이 바뀌지 않는다.
    fireEvent.click(screen.getByRole('checkbox', { name: '시뮬레이션 장비 숨기기' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '시뮬레이션 장비 숨기기' }));
    await waitFor(() => expect(screen.getByRole('img', { name: '5층 평면도' })).toBeInTheDocument());
  });

  it('identifies equipment by major and minor rather than the shared uuid', async () => {
    renderPage();

    await sidebar().findByText('실물 제세동기');
    // 목록(list) 탭으로 전환해야 태그 식별자가 보인다.
    fireEvent.click(screen.getByRole('button', { name: '목록' }));
    // 목록 뷰도 층 탭 단위라, 실물 태그가 있는 5층(M502)으로 옮겨야 그 카드가 보인다.
    fireEvent.click(screen.getByRole('button', { name: '5층' }));

    expect(await screen.findByText(/major 1 · minor 2/)).toBeInTheDocument();
    expect(screen.queryByText(/^fda50693$/)).not.toBeInTheDocument();
  });

  it('brings the equipment back when the toggle is off again', async () => {
    renderPage();

    await sidebar().findByText('모의 수액펌프');
    const toggle = screen.getByRole('checkbox', { name: '시뮬레이션 장비 숨기기' });
    fireEvent.click(toggle);
    await waitFor(() => expect(sidebar().queryByText('모의 수액펌프')).not.toBeInTheDocument());

    fireEvent.click(toggle);
    await waitFor(() => expect(sidebar().getByText('모의 수액펌프')).toBeInTheDocument());
  });
});
