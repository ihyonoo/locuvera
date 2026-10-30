import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom에는 IntersectionObserver가 없어, motion의 whileInView가 마운트 시 에러를 던진다.
class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// @ts-expect-error jsdom does not implement IntersectionObserver
globalThis.IntersectionObserver = IntersectionObserverMock;

// jsdom도 matchMedia를 구현하지 않는다. innerWidth 기반으로 matches를 판정하고,
// window resize 이벤트가 오면 재계산해 등록된 change 리스너에 통지하는 최소 구현.
// 테스트에서 뷰포트를 바꾸려면 innerWidth를 지정한 뒤 resize 이벤트를 dispatch하면 된다.
window.matchMedia = (query: string): MediaQueryList => {
  const minWidth = Number(/\(min-width:\s*(\d+)px\)/.exec(query)?.[1] ?? 0);
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const mql = {
    get matches() {
      return window.innerWidth >= minWidth;
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    dispatchEvent: () => true,
    addListener: () => {},
    removeListener: () => {},
  } as MediaQueryList;

  window.addEventListener('resize', () => {
    listeners.forEach((listener) => listener({ matches: mql.matches, media: query } as MediaQueryListEvent));
  });

  return mql;
};

// 기존 테스트들이 데스크탑 레이아웃(사이드바 나란히 배치가 시작되는 xl=1280px 이상)을
// 전제로 작성되어 있으므로, 테스트 환경 기본 뷰포트를 데스크탑 폭으로 맞춘다.
// 모바일 동작을 검증하는 테스트는 개별적으로 innerWidth를 좁혀 resize를 dispatch한다.
Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1440 });

// vite.config.ts가 test.globals를 켜지 않아 Testing Library의 자동 cleanup이 동작하지 않는다.
// 이걸 켜지 않으면 한 파일 안에 여러 render()가 있을 때 이전 테스트의 DOM이 남아
// 다음 테스트의 getByText 등이 중복 매치로 실패한다.
afterEach(() => cleanup());

// Node 25의 전역 localStorage(--localstorage-file 없이는 메서드가 없다)가 jsdom 것을 가린다.
// 브라우저에는 없는 문제라 테스트에서만 메모리 구현으로 바꾼다.
if (typeof globalThis.localStorage?.clear !== 'function') {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true });
}
