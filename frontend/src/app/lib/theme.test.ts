import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIGHT_LOCKED_PATHS,
  THEME_COLOR,
  THEME_STORAGE_KEY,
  applyTheme,
  getStoredTheme,
  isDarkThemeActive,
  isLightLockedPath,
  normalizePath,
  resolveTheme,
  storeTheme,
  subscribeThemeToRouter,
  syncThemeForPath,
} from './theme';

const THEMED_PATHS = [
  '/me',
  '/equipment',
  '/verification',
  '/admin/devices',
  '/admin/nfc-mapping',
  '/nfc/pump-001',
  '/auth/callback',
];
const LOCKED_PATHS = [
  '/',
  '/login',
  '/signup',
  '/signup/complete',
  '/find-id',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
];

function themeColorMeta() {
  return document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  themeColorMeta()?.remove();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getStoredTheme', () => {
  it('is light when nothing is stored', () => {
    expect(getStoredTheme()).toBe('light');
  });

  it('is dark only when dark is stored', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(getStoredTheme()).toBe('dark');
  });

  it('treats an unknown stored value as light', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(getStoredTheme()).toBe('light');
  });

  it('falls back to light when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getStoredTheme()).toBe('light');
  });
});

describe('storeTheme', () => {
  it('stores the chosen theme under the theme key', () => {
    storeTheme('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('ignores storage write failures', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => storeTheme('dark')).not.toThrow();
  });
});

describe('normalizePath', () => {
  it.each([
    ['/login/', '/login'],
    ['/login//', '/login'],
    ['', '/'],
    ['/', '/'],
    ['/me', '/me'],
  ])('%j → %j', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});

describe('isLightLockedPath', () => {
  it('lists the landing page and the seven auth pages in route order', () => {
    expect(LIGHT_LOCKED_PATHS).toEqual(LOCKED_PATHS);
  });

  it.each(LOCKED_PATHS)('locks %s to light', (path) => {
    expect(isLightLockedPath(path)).toBe(true);
  });

  it.each(THEMED_PATHS)('lets %s follow the stored theme', (path) => {
    expect(isLightLockedPath(path)).toBe(false);
  });

  it('ignores a trailing slash', () => {
    expect(isLightLockedPath('/login/')).toBe(true);
  });
});

describe('resolveTheme', () => {
  it('keeps light-locked pages light even when dark is stored', () => {
    expect(resolveTheme('/login', 'dark')).toBe('light');
  });

  it('uses the stored theme on themed pages', () => {
    expect(resolveTheme('/equipment', 'dark')).toBe('dark');
    expect(resolveTheme('/equipment', 'light')).toBe('light');
  });
});

describe('applyTheme', () => {
  it('adds the dark class and dark theme color', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
    applyTheme('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(meta.content).toBe(THEME_COLOR.dark);
    expect(isDarkThemeActive()).toBe(true);
  });

  it('removes the dark class and restores the light theme color', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
    applyTheme('dark');
    applyTheme('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(meta.content).toBe(THEME_COLOR.light);
    expect(isDarkThemeActive()).toBe(false);
  });

  it('works without a theme-color meta tag', () => {
    expect(() => applyTheme('dark')).not.toThrow();
    expect(document.documentElement).toHaveClass('dark');
  });
});

describe('syncThemeForPath', () => {
  it('applies the stored dark theme on a themed page', () => {
    storeTheme('dark');
    syncThemeForPath('/me');
    expect(isDarkThemeActive()).toBe(true);
  });

  it('clears dark on a light-locked page', () => {
    storeTheme('dark');
    syncThemeForPath('/me');
    syncThemeForPath('/');
    expect(isDarkThemeActive()).toBe(false);
  });
});

describe('subscribeThemeToRouter', () => {
  function fakeRouter(pathname: string) {
    let listener: ((state: { location: { pathname: string } }) => void) | null = null;
    return {
      state: { location: { pathname } },
      subscribe(fn: (state: { location: { pathname: string } }) => void) {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      navigate(to: string) {
        this.state = { location: { pathname: to } };
        listener?.(this.state);
      },
    };
  }

  it('syncs the current route immediately', () => {
    storeTheme('dark');
    subscribeThemeToRouter(fakeRouter('/equipment'));
    expect(isDarkThemeActive()).toBe(true);
  });

  it('follows later navigation between themed and light-locked pages', () => {
    storeTheme('dark');
    const router = fakeRouter('/equipment');
    subscribeThemeToRouter(router);
    router.navigate('/login');
    expect(isDarkThemeActive()).toBe(false);
    router.navigate('/me');
    expect(isDarkThemeActive()).toBe(true);
  });

  it('stops following navigation after unsubscribing', () => {
    storeTheme('dark');
    const router = fakeRouter('/equipment');
    const unsubscribe = subscribeThemeToRouter(router);
    unsubscribe();
    router.navigate('/login');
    expect(isDarkThemeActive()).toBe(true);
  });
});

// index.html의 인라인 스크립트는 TS를 import할 수 없어 목록·키·정규화를 복제한다 — 둘이 같아야 한다
describe('index.html theme bootstrap', () => {
  const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

  function runBootstrap(pathname: string, stored: string | null) {
    const root = { classes: new Set<string>(), classList: { add: (c: string) => root.classes.add(c) } };
    const meta = { content: THEME_COLOR.light, setAttribute: (_: string, v: string) => (meta.content = v) };
    const fakeDocument = {
      documentElement: root,
      querySelector: (selector: string) => (selector.includes('theme-color') ? meta : null),
    };
    const fakeStorage = { getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null) };
    new Function('localStorage', 'location', 'document', script)(fakeStorage, { pathname }, fakeDocument);
    return { dark: root.classes.has('dark'), themeColor: meta.content };
  }

  it('copies the light-locked path list and storage key verbatim', () => {
    expect(script).toContain(JSON.stringify(LIGHT_LOCKED_PATHS));
    expect(script).toContain(THEME_STORAGE_KEY);
  });

  it.each(THEMED_PATHS)('starts %s dark when dark is stored', (path) => {
    expect(runBootstrap(path, 'dark')).toEqual({ dark: true, themeColor: THEME_COLOR.dark });
  });

  it.each([...LOCKED_PATHS, '/login/'])('keeps %s light when dark is stored', (path) => {
    expect(runBootstrap(path, 'dark')).toEqual({ dark: false, themeColor: THEME_COLOR.light });
  });

  it('stays light when nothing is stored', () => {
    expect(runBootstrap('/equipment', null).dark).toBe(false);
  });

  it('survives a storage that throws', () => {
    const fakeDocument = { documentElement: { classList: { add: () => {} } }, querySelector: () => null };
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() =>
      new Function('localStorage', 'location', 'document', script)(throwing, { pathname: '/me' }, fakeDocument),
    ).not.toThrow();
  });

  it('paints the first dark frame only on screen, never in print', () => {
    expect(style).toMatch(/@media screen\s*\{\s*html\.dark\s*\{[^}]*background:\s*#111214/);
  });
});
