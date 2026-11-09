// 자동 순환과 직접 조작을 오가는 상태 기계
// 자동 순환은 '직접 조작하기'로만 멈춘다 — 마우스를 움직이거나 눌러도 계속 돈다
// 직접 조작 중에는 idleMs 동안 입력이 없거나 돌아가기를 누르면 다음 장면부터 다시 돈다
export type ExhibitMode = 'auto' | 'manual';

type ControllerOptions = {
  sceneCount: number;
  idleMs: number;
  run: (startAt: number, signal: AbortSignal, onScene: (index: number) => void) => Promise<void>;
  onMode: (mode: ExhibitMode) => void;
};

export function createExhibitController({ sceneCount, idleMs, run, onMode }: ControllerOptions) {
  let tour: AbortController | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let currentScene = 0;

  const startTour = (startAt: number) => {
    clearTimeout(idleTimer);
    tour = new AbortController();
    onMode('auto');
    run(startAt, tour.signal, (index) => {
      currentScene = index;
    }).catch(() => {});
  };

  const resumeFromNext = () => startTour((currentScene + 1) % sceneCount);

  const restartIdleCountdown = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(resumeFromNext, idleMs);
  };

  return {
    start() {
      startTour(0);
    },
    takeOver() {
      if (!tour) return;
      tour.abort();
      tour = null;
      onMode('manual');
      restartIdleCountdown();
    },
    // 직접 조작 중 입력만 센다
    humanInput() {
      if (!tour) restartIdleCountdown();
    },
    resume() {
      if (tour) return;
      resumeFromNext();
    },
    // 자동 시연 중 진행도바에서 고른 장면으로 — 그 장면 간지부터 다시 튼다
    jumpTo(index: number) {
      if (!tour) return;
      tour.abort();
      startTour(index);
    },
    stop() {
      clearTimeout(idleTimer);
      tour?.abort();
      tour = null;
    },
  };
}
