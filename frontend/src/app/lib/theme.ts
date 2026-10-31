// 화면 테마(라이트/다크). 기기(브라우저)별로 저장하고, 로그인 계열 화면은 늘 라이트다.
// '/'는 곧바로 로그인으로 넘어가지만, 넘어가기 전 첫 페인트가 다크로 깜빡이지 않게 목록에 둔다.
// index.html의 인라인 스크립트가 첫 페인트 전에 같은 판정을 한다 — 목록·키·정규화를 바꾸면 거기도 고친다(theme.test.ts가 확인).

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'locuvera-theme';

export const LIGHT_LOCKED_PATHS: readonly string[] = [
  '/',
  '/login',
  '/signup',
  '/signup/complete',
  '/find-id',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
];

// 휴대폰 브라우저 주소창 색 — 앱 상단바 배경(--app-nav-background)과 같다
export const THEME_COLOR: Record<Theme, string> = { light: '#f1f1f1', dark: '#1a1b1e' };

// 저장소 쓰기가 막힌 브라우저(사생활 보호 모드 등)에서 고른 값 — 이 탭에서만 쓰고 새로고침하면 사라진다
let unsavedTheme: Theme | null = null;

export function getStoredTheme(): Theme {
  if (unsavedTheme) return unsavedTheme;
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    unsavedTheme = null;
  } catch {
    unsavedTheme = theme;
  }
}

export function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function isLightLockedPath(pathname: string): boolean {
  return LIGHT_LOCKED_PATHS.includes(normalizePath(pathname));
}

export function resolveTheme(pathname: string, stored: Theme): Theme {
  return isLightLockedPath(pathname) ? 'light' : stored;
}

export function applyTheme(theme: Theme, doc: Document = document): void {
  doc.documentElement.classList.toggle('dark', theme === 'dark');
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

export function syncThemeForPath(pathname: string): void {
  applyTheme(resolveTheme(pathname, getStoredTheme()));
}

export function isDarkThemeActive(doc: Document = document): boolean {
  return doc.documentElement.classList.contains('dark');
}

type RouterLike = {
  state: { location: { pathname: string } };
  subscribe(fn: (state: { location: { pathname: string } }) => void): () => void;
};

export function subscribeThemeToRouter(router: RouterLike): () => void {
  syncThemeForPath(router.state.location.pathname);
  return router.subscribe((state) => syncThemeForPath(state.location.pathname));
}
