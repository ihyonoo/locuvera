import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeAuthSession } from './lib/auth';
import { THEME_STORAGE_KEY } from './lib/theme';

// 라우터는 모듈을 불러올 때 현재 주소로 만들어진다 — 주소를 먼저 정하고 App을 동적으로 불러온다
async function renderAppAt(path: string) {
  window.history.replaceState(null, '', path);
  vi.resetModules();
  const [{ default: App }, { router }] = await Promise.all([import('./App'), import('./routes')]);
  render(<App />);
  return router;
}

describe('App theme sync', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.classList.remove('dark');
    // 화면들이 부르는 API는 응답하지 않게 둔다
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('keeps the login page light even when dark is stored', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    await renderAppAt('/login');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('turns dark when navigating from a light-locked page to an app page', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    // 로그인하지 않으면 마이페이지가 로그인 화면으로 돌려보낸다
    storeAuthSession({
      token: 'test-token',
      expires_at: 9999999999,
      user: { user_id: 1, username: 'tester', display_name: '테스터', role: 'staff' },
    });
    const router = await renderAppAt('/login');
    await act(() => router.navigate('/me'));
    expect(document.documentElement).toHaveClass('dark');
  });
});
