import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import MyPage from './MyPage';

function storeSession(role: 'staff' | 'admin') {
  sessionStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: 'test-token',
      expires_at: 9999999999,
      user: { user_id: 1, username: 'u', display_name: 'u', role },
    }),
  );
}

function renderMyPage() {
  render(
    <MemoryRouter initialEntries={['/me']}>
      <MyPage />
    </MemoryRouter>,
  );
}

describe('MyPage header', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            url.includes('/usage/')
              ? { ok: true, items: [] }
              : {
                  ok: true,
                  user: {
                    user_id: 1,
                    username: 'nurse07',
                    display_name: '오태윤',
                    role: 'staff',
                    department: '간호부',
                    position: '간호사',
                  },
                },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('heads the page with the name, department and position', async () => {
    storeSession('staff');
    renderMyPage();

    expect(await screen.findByRole('heading', { level: 1, name: '오태윤' })).toBeInTheDocument();
    expect(screen.getByText('간호부 · 간호사')).toBeInTheDocument();
    expect(screen.getByText('nurse07')).toBeInTheDocument();
  });

  it('uses the staff menu for staff', () => {
    storeSession('staff');
    renderMyPage();
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect(within(nav).getByRole('button', { name: '장비 검색' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: '마이페이지' })).toHaveAttribute('aria-current', 'page');
  });

  // 메뉴는 세션의 권한으로 바로 정한다(/auth/me 응답을 기다리지 않는다)
  it('uses the admin menu for admins', () => {
    storeSession('admin');
    renderMyPage();
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect(within(nav).getByRole('button', { name: '가입 승인' })).toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: '장비 검색' })).not.toBeInTheDocument();
  });

  // 화면 테마는 메뉴바 아이콘으로 옮겼다
  it('leaves the screen theme to the menu bar', async () => {
    storeSession('staff');
    renderMyPage();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('radiogroup', { name: '화면 테마' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다크 모드로 바꾸기' })).toBeInTheDocument();
  });
});

describe('MyPage usage history', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  function mockHistory(items: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () =>
            url.includes('/usage/')
              ? { ok: true, items }
              : { ok: true, user: { user_id: 1, username: 'u', display_name: 'u', role: 'staff' } },
        }),
      ),
    );
  }

  it('lists each usage record with where and when it was borrowed and returned', async () => {
    storeSession('staff');
    mockHistory([
      {
        usage_id: 3,
        usage_status: 'returned',
        equipment: { name: '제세동기-001', type: '제세동기' },
        checkout: { location: '응급실', at: 1792000000 },
        return: { location: '3층 병동', at: 1792003600 },
        movement_path: [
          { location: '응급실', at: 1792000000 },
          { location: '3층 병동', at: 1792003600 },
        ],
      },
    ]);
    renderMyPage();

    const record = (await screen.findByText('제세동기-001')).closest('li') as HTMLElement;
    expect(within(record).getByText('반납됨')).toBeInTheDocument();
    expect(within(record).getByText(/응급실 → 3층 병동/)).toBeInTheDocument();
    expect(screen.getByText('1건')).toBeInTheDocument();
  });

  it('points to the equipment search when there is no history yet', async () => {
    storeSession('staff');
    mockHistory([]);
    renderMyPage();

    expect(await screen.findByText('아직 대여하거나 반납한 장비가 없습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '장비 찾기' })).toBeInTheDocument();
  });
});

describe('MyPage verification email', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('shows failure when the resend API rejects the request', async () => {
    storeSession('staff');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url.includes('resend-verification')
            ? { ok: false, status: 500, json: async () => ({ ok: false, message: '서버 오류' }) }
            : {
                ok: true,
                status: 200,
                json: async () => ({
                  ok: true,
                  user: {
                    user_id: 1,
                    username: 'u',
                    display_name: 'u',
                    role: 'staff',
                    email: 'u@example.com',
                    email_verified: false,
                  },
                }),
              },
        ),
      ),
    );
    renderMyPage();

    const emailRow = (await screen.findByText('이메일', { selector: '.staff-setting__label' })).closest(
      '.staff-setting',
    ) as HTMLElement;
    fireEvent.click(within(emailRow).getByRole('button', { name: '변경' }));
    fireEvent.click(await screen.findByRole('button', { name: '인증 메일 다시 보내기' }));

    expect(await screen.findByText('인증 메일 재발송에 실패했습니다.')).toBeInTheDocument();
  });
});

describe('MyPage account actions for demo accounts', () => {
  const DEMO_NOTICE = '데모 체험 계정에서는 계정 설정을 변경할 수 없습니다.';

  function mockMe(overrides: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          user: {
            user_id: 1,
            username: 'u',
            display_name: 'u',
            role: 'staff',
            google_linked: true,
            ...overrides,
          },
        }),
      }),
    );
  }

  // 설정 줄 이름으로 줄을 특정한다 — '변경' 버튼이 비밀번호·이메일 두 곳에 있어서다.
  function row(label: string) {
    const name = screen.getByText(label, { selector: '.staff-setting__label' });
    return within(name.closest('.staff-setting') as HTMLElement);
  }

  async function renderDemoPage() {
    storeSession('staff');
    renderMyPage();
    await screen.findByText('계정');
  }

  beforeEach(() => {
    sessionStorage.clear();
    mockMe({ is_demo: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('hides Google linking while Google login is off (default)', async () => {
    await renderDemoPage();

    expect(screen.queryByText('Google 연동', { selector: '.staff-setting__label' })).not.toBeInTheDocument();
    expect(screen.queryByText('Google', { selector: 'dt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /연동/ })).not.toBeInTheDocument();
  });

  it('warns instead of opening the password form', async () => {
    await renderDemoPage();

    fireEvent.click(row('비밀번호').getByRole('button', { name: '변경' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(screen.queryByLabelText('현재 비밀번호')).not.toBeInTheDocument();
  });

  it('warns instead of opening the email form', async () => {
    await renderDemoPage();

    fireEvent.click(row('이메일').getByRole('button', { name: '변경' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(screen.queryByLabelText('새 이메일')).not.toBeInTheDocument();
  });

  it('warns instead of calling the google unlink API', async () => {
    vi.stubEnv('VITE_GOOGLE_LOGIN_ENABLED', 'true');
    await renderDemoPage();
    const callsBefore = vi.mocked(fetch).mock.calls.length;

    fireEvent.click(row('Google 연동').getByRole('button', { name: '연동 해제' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });

  it('warns instead of opening the withdraw form', async () => {
    await renderDemoPage();

    fireEvent.click(screen.getByRole('button', { name: '회원 탈퇴' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(screen.queryByLabelText('현재 비밀번호 확인')).not.toBeInTheDocument();
  });

  it('tells demo accounts up front that settings are locked', async () => {
    await renderDemoPage();

    expect(screen.getByText('데모 체험 계정은 계정 설정을 바꿀 수 없습니다.')).toBeInTheDocument();
  });

  it('still opens the password form for a normal account', async () => {
    mockMe({ is_demo: false });
    await renderDemoPage();

    fireEvent.click(row('비밀번호').getByRole('button', { name: '변경' }));

    expect(await screen.findByLabelText('현재 비밀번호')).toBeInTheDocument();
    expect(screen.queryByText(DEMO_NOTICE)).not.toBeInTheDocument();
  });
});
