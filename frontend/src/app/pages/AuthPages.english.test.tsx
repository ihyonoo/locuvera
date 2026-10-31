import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';
import Login from './Login';
import SignUp from './SignUp';
import SignUpComplete from './SignUpComplete';
import FindId from './FindId';
import ForgotPassword from './ForgotPassword';
import ResetPassword from './ResetPassword';
import VerifyEmail from './VerifyEmail';

// 인증 7개 화면의 제목·버튼은 영어다. 아래 보조 링크·라벨·안내 문장·권한 이름은 한국어로 둔다.
const PAGES: { path: string; hash?: string; element: ReactElement; heading: string; buttons: string[] }[] = [
  {
    path: '/login',
    element: <Login />,
    heading: 'Login',
    buttons: ['Login', '회원가입', '아이디 찾기', '비밀번호 찾기'],
  },
  { path: '/signup', element: <SignUp />, heading: 'Sign up', buttons: ['Create account', '로그인으로 돌아가기'] },
  {
    path: '/signup/complete',
    hash: '#pending=p&email=a%40b.com&name=n',
    element: <SignUpComplete />,
    heading: 'Complete sign-up',
    buttons: ['Create account'],
  },
  { path: '/find-id', element: <FindId />, heading: 'Find ID', buttons: ['Find ID', '로그인으로 돌아가기'] },
  {
    path: '/forgot-password',
    element: <ForgotPassword />,
    heading: 'Forgot password',
    buttons: ['Send reset link', '로그인으로 돌아가기'],
  },
  {
    path: '/reset-password?token=t',
    element: <ResetPassword />,
    heading: 'Reset password',
    buttons: ['Change password'],
  },
  { path: '/verify-email', element: <VerifyEmail />, heading: 'Verify email', buttons: ['Go to login'] },
];

describe('auth pages speak English in titles and buttons, Korean in the helper links', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  });

  afterEach(() => {
    window.location.hash = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(PAGES)('$path shows "$heading"', ({ path, hash, element, heading, buttons }) => {
    window.location.hash = hash ?? '';
    render(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>);

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    for (const name of buttons) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });
});
