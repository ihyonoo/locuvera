// 전시 대본이 화면 요소를 찾고 다루는 DOM 도구
// 모두 스크립트가 만든 이벤트라 isTrusted가 false다 — 사람 입력 감지와 섞이지 않는다
export type Target = {
  selector: string;
  // 요소 글자에 이 문자열이 들어 있어야 한다
  text?: string;
};

const POLL_MS = 100;

export class TargetNotFoundError extends Error {
  constructor(target: Target) {
    super(`전시 대본 대상을 찾지 못함: ${target.selector}${target.text ? ` "${target.text}"` : ''}`);
    this.name = 'TargetNotFoundError';
  }
}

export function abortError(): DOMException {
  return new DOMException('전시 재생 중단', 'AbortError');
}

export function findTarget(target: Target, root: ParentNode = document): HTMLElement | null {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(target.selector));
  if (!target.text) return candidates[0] ?? null;
  return candidates.find((el) => el.textContent?.includes(target.text as string)) ?? null;
}

export function waitForTarget(target: Target, signal: AbortSignal, timeoutMs: number): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const check = () => {
      const el = findTarget(target);
      if (el) {
        signal.removeEventListener('abort', onAbort);
        resolve(el);
      } else if (Date.now() - startedAt >= timeoutMs) {
        signal.removeEventListener('abort', onAbort);
        reject(new TargetNotFoundError(target));
      } else {
        timer = setTimeout(check, POLL_MS);
      }
    };

    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    check();
  });
}

// React 제어 입력은 value 대입만으로는 상태가 바뀌지 않는다 — 원래 setter로 넣고 input 이벤트를 보낸다
export function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function scrollTargetBy(el: HTMLElement, by: number) {
  if (typeof el.scrollBy === 'function') {
    el.scrollBy({ top: by, behavior: 'smooth' });
  } else {
    el.scrollTop += by;
  }
}
