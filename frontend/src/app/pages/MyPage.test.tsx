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
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, user: { user_id: 1, username: 'u', display_name: 'u', role: 'staff' } }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prints no page title above the content for staff', () => {
    storeSession('staff');
    renderMyPage();
    // 상단 네비에 이미 '마이페이지' 탭이 있어 같은 제목을 본문 위에 또 찍지 않는다.
    expect(document.querySelector('.page-header__title')).toBeNull();
    expect(screen.getByRole('button', { name: '마이페이지' })).toBeInTheDocument();
  });

  it('prints no page title above the content for admins either', () => {
    storeSession('admin');
    renderMyPage();
    expect(document.querySelector('.page-header__title')).toBeNull();
  });

  // 다른 관리 화면(NFC 매핑·장비 검색)과 같은 1360px 본문 폭을 쓴다. 권한에 따라 달라지지 않는다.
  it.each(['staff', 'admin'] as const)('gives the %s content the same wide body as other pages', (role) => {
    storeSession(role);
    renderMyPage();

    expect(document.querySelector('.max-w-\\[1360px\\]')).not.toBeNull();
    expect(document.querySelector('.max-w-3xl')).toBeNull();
    expect(document.querySelector('.app-shell__container--wide')).not.toBeNull();
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

    const emailPanel = (await screen.findByText('이메일 변경', { selector: '.panel-title' })).closest(
      'section',
    ) as HTMLElement;
    fireEvent.click(within(emailPanel).getByRole('button', { name: '변경' }));
    fireEvent.click(await screen.findByRole('button', { name: '인증 메일 재발송' }));

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

  // 패널 제목으로 섹션을 특정한다 — '변경' 버튼이 비밀번호·이메일 두 곳에 있어서다.
  function panel(title: string) {
    const heading = screen.getByText(title, { selector: '.panel-title' });
    return within(heading.closest('section') as HTMLElement);
  }

  async function renderDemoPage() {
    storeSession('staff');
    renderMyPage();
    await screen.findByText('내 정보');
  }

  beforeEach(() => {
    sessionStorage.clear();
    mockMe({ is_demo: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('warns instead of opening the password form', async () => {
    await renderDemoPage();

    fireEvent.click(panel('비밀번호 변경').getByRole('button', { name: '변경' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(screen.queryByLabelText('현재 비밀번호')).not.toBeInTheDocument();
  });

  it('warns instead of opening the email form', async () => {
    await renderDemoPage();

    fireEvent.click(panel('이메일 변경').getByRole('button', { name: '변경' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(screen.queryByLabelText('새 이메일')).not.toBeInTheDocument();
  });

  it('warns instead of calling the google unlink API', async () => {
    await renderDemoPage();
    const callsBefore = vi.mocked(fetch).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Google 연동 해제' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsBefore);
  });

  it('warns instead of opening the withdraw form', async () => {
    await renderDemoPage();

    fireEvent.click(panel('회원 탈퇴').getByRole('button', { name: '회원 탈퇴' }));

    expect(await screen.findByText(DEMO_NOTICE)).toBeInTheDocument();
    expect(screen.queryByLabelText('현재 비밀번호 확인')).not.toBeInTheDocument();
  });

  it('still opens the password form for a normal account', async () => {
    mockMe({ is_demo: false });
    await renderDemoPage();

    fireEvent.click(panel('비밀번호 변경').getByRole('button', { name: '변경' }));

    expect(await screen.findByLabelText('현재 비밀번호')).toBeInTheDocument();
    expect(screen.queryByText(DEMO_NOTICE)).not.toBeInTheDocument();
  });
});
