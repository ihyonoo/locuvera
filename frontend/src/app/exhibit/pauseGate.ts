// 자동 시연을 지금 화면에 멈춰 세운다 — 재생기의 sleep이 매 단계 경계에서 이 문을 지난다
// 멈춤 중에는 통과를 막았다가 '계속'을 누르면 기다리던 것을 한꺼번에 흘려보낸다
// signal이 끊기면(직접 조작 전환) 멈춤과 무관하게 그 자리에서 중단된다
import { abortError } from './dom';

export type PauseGate = {
  paused: () => boolean;
  pause: () => void;
  resume: () => void;
  // 멈춤이 아니면 곧바로, 멈춤이면 resume이나 abort까지 기다린다
  wait: (signal: AbortSignal) => Promise<void>;
};

export function createPauseGate(): PauseGate {
  let paused = false;
  let waiters: Array<() => void> = [];

  return {
    paused: () => paused,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      const release = waiters;
      waiters = [];
      for (const wake of release) wake();
    },
    wait(signal) {
      if (!paused) return Promise.resolve();
      if (signal.aborted) return Promise.reject(abortError());
      return new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          waiters = waiters.filter((w) => w !== wake);
          reject(abortError());
        };
        waiters.push(wake);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}
