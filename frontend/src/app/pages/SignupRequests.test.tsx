import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import SignupRequests from './SignupRequests';

const items = [
  {
    request_id: 7,
    employee_no: '20261031',
    display_name: '홍길동',
    email: 'hong@example.com',
    created_at: '2026-10-31T09:00:00+09:00',
  },
  {
    request_id: 8,
    employee_no: '20261032',
    display_name: '김영희',
    email: 'kim@example.com',
    created_at: '2026-10-31T10:00:00+09:00',
  },
];

function signIn(role: string) {
  sessionStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: 'test-token',
      expires_at: 9999999999,
      user: { user_id: 1, username: 'admin1', display_name: '관리자', role },
    }),
  );
}

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
}

// 목록 조회는 items를 돌려주고, 나머지 호출은 handle이 정한다.
function mockApi(
  handle: (url: string, init?: RequestInit) => Promise<Response> = () => jsonResponse(200, { ok: true }),
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return jsonResponse(200, { ok: true, count: items.length, items });
      return handle(url, init);
    }),
  );
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/admin/signup-requests']}>
      <Routes>
        <Route path="/admin/signup-requests" element={<SignupRequests />} />
        <Route path="/equipment" element={<div>장비 검색</div>} />
        <Route path="/login" element={<div>로그인 화면</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function rowFor(employeeNo: string) {
  return screen.getByText(employeeNo).closest('li') as HTMLElement;
}

function mutationCalls() {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
}

describe('SignupRequests', () => {
  beforeEach(() => {
    sessionStorage.clear();
    signIn('admin');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends staff away to their home screen', () => {
    signIn('staff');
    mockApi();
    renderPage();
    expect(screen.getByText('장비 검색')).toBeInTheDocument();
  });

  it('lists pending requests with employee number, name and email', async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText('20261031')).toBeInTheDocument();
    const row = rowFor('20261031');
    expect(within(row).getByText('홍길동')).toBeInTheDocument();
    expect(within(row).getByText('hong@example.com')).toBeInTheDocument();
    expect(screen.getByText('20261032')).toBeInTheDocument();
  });

  it('says so when nothing is waiting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(200, { ok: true, count: 0, items: [] })),
    );
    renderPage();
    expect(await screen.findByText('대기 중인 가입 요청이 없습니다.')).toBeInTheDocument();
  });

  it('shows the server message instead of logging out when a demo admin is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(403, { detail: '데모 계정에서는 사용할 수 없는 기능입니다.' })),
    );
    renderPage();
    expect(await screen.findByText('데모 계정에서는 사용할 수 없는 기능입니다.')).toBeInTheDocument();
    expect(screen.queryByText('로그인 화면')).not.toBeInTheDocument();
  });

  it('approves as staff with department and position, then drops the row', async () => {
    mockApi();
    renderPage();
    await screen.findByText('20261031');
    fireEvent.click(within(rowFor('20261031')).getByRole('button', { name: '승인' }));

    const dialog = await screen.findByRole('dialog');
    // 남의 사번에 자기 이메일을 넣은 요청을 막으려면 셋이 한 사람 것인지 봐야 한다.
    expect(within(dialog).getByText(/사번·이름·이메일이 같은 직원의 것인지 확인/)).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: '의료진' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(within(dialog).getByLabelText('부서'), { target: { value: '내과' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '승인하기' }));

    await waitFor(() => expect(mutationCalls()).toHaveLength(1));
    const [url, init] = mutationCalls()[0];
    expect(String(url)).toMatch(/\/admin\/signup-requests\/7\/approve$/);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ role: 'staff', department: '내과', position: '간호사' });
    await waitFor(() => expect(screen.queryByText('20261031')).not.toBeInTheDocument());
    expect(screen.getByText(/메일이 오지 않으면 요청자에게 비밀번호 찾기를 안내하세요/)).toBeInTheDocument();
  });

  it('hides department and position when approving as an admin', async () => {
    mockApi();
    renderPage();
    await screen.findByText('20261031');
    fireEvent.click(within(rowFor('20261031')).getByRole('button', { name: '승인' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: '관리자' }));
    expect(within(dialog).queryByLabelText('부서')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('직책')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '승인하기' }));

    await waitFor(() => expect(mutationCalls()).toHaveLength(1));
    expect(JSON.parse(mutationCalls()[0][1]?.body as string)).toEqual({
      role: 'admin',
      department: null,
      position: null,
    });
  });

  it('keeps the dialog open with the reason when approval fails', async () => {
    mockApi(() => jsonResponse(409, { detail: '같은 사번이나 이메일의 계정이 이미 있습니다.' }));
    renderPage();
    await screen.findByText('20261031');
    fireEvent.click(within(rowFor('20261031')).getByRole('button', { name: '승인' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '승인하기' }));

    expect(await screen.findByText('같은 사번이나 이메일의 계정이 이미 있습니다.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('20261031')).toBeInTheDocument();
  });

  // 응답 전에 닫으면 결과(오류 문구)가 사라지고, 늦게 온 응답이 다른 요청의 대화상자를 닫는다.
  it('cannot be closed while the approval is being saved', async () => {
    mockApi(() => new Promise(() => {}));
    renderPage();
    await screen.findByText('20261031');
    fireEvent.click(within(rowFor('20261031')).getByRole('button', { name: '승인' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '승인하기' }));

    await waitFor(() => expect(within(dialog).getByRole('button', { name: '취소' })).toBeDisabled());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('rejects only after confirming, then drops the row', async () => {
    mockApi();
    renderPage();
    await screen.findByText('20261032');
    fireEvent.click(within(rowFor('20261032')).getByRole('button', { name: '거절' }));

    const dialog = await screen.findByRole('dialog');
    expect(mutationCalls()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: '거절하기' }));

    await waitFor(() => expect(mutationCalls()).toHaveLength(1));
    const [url, init] = mutationCalls()[0];
    expect(String(url)).toMatch(/\/admin\/signup-requests\/8$/);
    expect(init?.method).toBe('DELETE');
    await waitFor(() => expect(screen.queryByText('20261032')).not.toBeInTheDocument());
    expect(screen.getByText('20261031')).toBeInTheDocument();
  });
});
