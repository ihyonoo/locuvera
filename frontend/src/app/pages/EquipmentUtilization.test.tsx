import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import EquipmentUtilization from './EquipmentUtilization';
import type { UtilizationResponse, UtilizationType } from '../lib/utilization';

function heat(cells: Record<string, number> = {}) {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const [key, value] of Object.entries(cells)) {
    const [day, hour] = key.split('-').map(Number);
    grid[day][hour] = value;
  }
  return grid;
}

function hours(points: Record<number, number> = {}) {
  return Array.from({ length: 24 }, (_, hour) => points[hour] ?? 0);
}

function profile(weekday: Record<number, number>, weekend: Record<number, number> = {}) {
  return { weekday: hours(weekday), weekend: hours(weekend) };
}

function unit(name: string, utilization: number, checkouts: number) {
  return { tag_id: `tag-${name}`, equipment_name: name, utilization, checkout_count: checkouts };
}

const TYPES: UtilizationType[] = [
  {
    equipment_type: '혈액투석기',
    unit_count: 3,
    utilization: 0.61,
    peak_hour: 14,
    peak_utilization: 0.92,
    checkout_count: 65,
    verdict: 'shortage',
    additional_units: 1,
    units: [unit('혈액투석기-001', 0.7, 30), unit('혈액투석기-002', 0.6, 35), unit('혈액투석기-003', 0, 0)],
  },
  {
    equipment_type: '수액펌프',
    unit_count: 5,
    utilization: 0.21,
    peak_hour: 12,
    peak_utilization: 0.32,
    checkout_count: 212,
    verdict: 'adequate',
    additional_units: null,
    units: [unit('수액펌프-002', 0.3, 60)],
  },
  {
    equipment_type: '이동형 심전도기',
    unit_count: 2,
    utilization: 0.05,
    peak_hour: 8,
    peak_utilization: 0.15,
    checkout_count: 178,
    verdict: 'idle',
    additional_units: null,
    units: [unit('이동형 심전도기-001', 0.06, 90)],
  },
  {
    equipment_type: '제세동기',
    unit_count: 4,
    utilization: 0.01,
    peak_hour: 18,
    peak_utilization: 0.02,
    checkout_count: 27,
    verdict: 'essential',
    additional_units: null,
    units: [unit('제세동기-001', 0.01, 27)],
  },
];

const RESPONSE: UtilizationResponse = {
  ok: true,
  period: { days: 30, start: '2026-10-11T00:00:00+09:00', end: '2026-10-31T23:00:00+09:00' },
  summary: { utilization: 0.131, shortage_type_count: 1, idle_type_count: 1 },
  types: TYPES,
  heatmap: {
    all: heat({ '0-10': 0.5 }),
    by_type: {
      혈액투석기: heat({ '0-14': 0.92 }),
      수액펌프: heat({ '1-12': 0.32 }),
      '이동형 심전도기': heat({ '2-8': 0.15 }),
      제세동기: heat({ '3-18': 0.02 }),
    },
  },
  hourly: {
    all: profile({ 10: 0.5 }, { 10: 0.2 }),
    by_type: {
      혈액투석기: profile({ 14: 0.92 }),
      수액펌프: profile({ 12: 0.32 }),
      '이동형 심전도기': profile({ 8: 0.15 }),
      제세동기: profile({ 18: 0.02 }),
    },
  },
};

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
}

function mockApi(body: unknown = RESPONSE, status = 200) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => jsonResponse(status, body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/admin/utilization']}>
      <Routes>
        <Route path="/admin/utilization" element={<EquipmentUtilization />} />
        <Route path="/equipment" element={<div>장비 검색</div>} />
        <Route path="/login" element={<div>로그인 화면</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function typeRow(name: string) {
  return within(screen.getByRole('group', { name: '장비 종류' })).getByRole('button', {
    name: new RegExp(`^${name}`),
  });
}

function detail() {
  return screen.getByRole('region', { name: '선택한 장비 상세' });
}

describe('EquipmentUtilization', () => {
  beforeEach(() => {
    sessionStorage.setItem(
      'auth_session',
      JSON.stringify({
        token: 'test-token',
        expires_at: 9999999999,
        user: { user_id: 1, username: 'admin1', display_name: '관리자', role: 'admin' },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('shows the actual period and the summary numbers', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('10월 11일 ~ 10월 31일 · 21일')).toBeInTheDocument();
    const summary = screen.getByTestId('utilization-summary');
    // 요약은 제목과 같은 줄에 붙는다
    expect(screen.getByRole('heading', { name: '가동률 분석' }).parentElement).toContainElement(summary);
    expect(within(summary).getByText('전체 가동률').parentElement).toHaveTextContent('13%');
    expect(within(summary).getByText('추가 구매 검토').parentElement).toHaveTextContent('1종');
    expect(within(summary).getByText('유휴').parentElement).toHaveTextContent('1종');
  });

  it('lists every type with units, utilization and verdict', async () => {
    mockApi();
    renderPage();

    await screen.findByRole('group', { name: '장비 종류' });
    expect(typeRow('혈액투석기')).toHaveTextContent('3대');
    expect(typeRow('혈액투석기')).toHaveTextContent('61%');
    expect(typeRow('혈액투석기')).toHaveTextContent('추가 구매 검토');
    expect(typeRow('이동형 심전도기')).toHaveTextContent('유휴');
    expect(typeRow('제세동기')).toHaveTextContent('필수 비치');
  });

  it('shows the whole hospital by default', async () => {
    mockApi();
    renderPage();

    await screen.findByRole('region', { name: '선택한 장비 상세' });
    expect(within(detail()).getByRole('heading', { name: '전체 장비' })).toBeInTheDocument();
    expect(detail()).toHaveTextContent('14대 · 가동률 13%');
    expect(within(detail()).getByTitle('10시 · 평일 50% · 주말 20%')).toBeInTheDocument();
    expect(typeRow('전체 장비')).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches the detail, heatmap and units to the clicked type', async () => {
    mockApi();
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^혈액투석기/ }));

    expect(typeRow('혈액투석기')).toHaveAttribute('aria-pressed', 'true');
    expect(within(detail()).getByRole('heading', { name: '혈액투석기' })).toBeInTheDocument();
    expect(detail()).toHaveTextContent('3대 · 가동률 61% · 대여 65회');
    expect(detail()).toHaveTextContent('14시대 가동률 92% — 1대 추가 검토');
    expect(within(detail()).getByTitle('14시 · 평일 92% · 주말 0%')).toBeInTheDocument();
    const units = screen.getByRole('list', { name: '장비별 가동률' });
    expect(within(units).getByText('혈액투석기-003').closest('li')).toHaveTextContent('미사용');
    expect(within(units).getByText('혈액투석기-001').closest('li')).toHaveTextContent('대여 30회');
  });

  it('draws the weekday and weekend line chart by default', async () => {
    mockApi();
    renderPage();

    await screen.findByRole('region', { name: '선택한 장비 상세' });
    const toggle = within(detail()).getByRole('group', { name: '그래프 형태' });
    expect(within(toggle).getByRole('button', { name: '그래프' })).toHaveAttribute('aria-pressed', 'true');
    expect(detail()).toHaveTextContent('평일(월~금)');
    expect(detail()).toHaveTextContent('주말(토·일)');
    expect(detail()).toHaveTextContent('판정은 모든 요일을 합친 시간대 가동률 기준입니다.');
    expect(within(detail()).queryByTitle('월 10시 · 50%')).not.toBeInTheDocument();
  });

  it('switches to the weekday by hour heatmap and keeps it while changing type', async () => {
    mockApi();
    renderPage();

    await screen.findByRole('region', { name: '선택한 장비 상세' });
    fireEvent.click(within(detail()).getByRole('button', { name: '히트맵' }));

    expect(within(detail()).getByTitle('월 10시 · 50%')).toBeInTheDocument();
    expect(within(detail()).queryByTitle('10시 · 평일 50% · 주말 20%')).not.toBeInTheDocument();

    fireEvent.click(typeRow('혈액투석기'));
    expect(within(detail()).getByTitle('월 14시 · 92%')).toBeInTheDocument();
  });

  it('shows the busiest hour for an adequate type', async () => {
    mockApi();
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^수액펌프/ }));

    expect(detail()).toHaveTextContent('가장 바쁜 12시대 32%');
  });

  it('refetches with the chosen period', async () => {
    const fetchMock = mockApi();
    renderPage();
    await screen.findByRole('group', { name: '장비 종류' });

    fireEvent.click(screen.getByRole('button', { name: '7일' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('days=7'), expect.anything()),
    );
    expect(fetchMock.mock.calls[0][0]).toContain('/admin/utilization?days=30');
  });

  it('shows the empty state when nothing was checked out', async () => {
    mockApi({ ...RESPONSE, types: TYPES.map((t) => ({ ...t, checkout_count: 0 })) });
    renderPage();

    expect(await screen.findByText('이 기간에는 사용 기록이 없습니다.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '장비 종류' })).not.toBeInTheDocument();
  });

  it('shows the server error message', async () => {
    mockApi({ detail: '가동률 조회 중 데이터베이스 오류가 발생했습니다.' }, 500);
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('가동률 조회 중 데이터베이스 오류가 발생했습니다.');
  });

  it('sends staff back to equipment search', async () => {
    sessionStorage.setItem(
      'auth_session',
      JSON.stringify({
        token: 'test-token',
        expires_at: 9999999999,
        user: { user_id: 2, username: 'nurse1', display_name: '간호사', role: 'staff' },
      }),
    );
    mockApi();
    renderPage();

    expect(await screen.findByText('장비 검색')).toBeInTheDocument();
  });
});
