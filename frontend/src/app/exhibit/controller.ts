// 자동 순환과 직접 조작을 오가는 상태 기계
// 사람이 만지면 순환을 끊고, idleMs 동안 입력이 없거나 돌아가기를 누르면 다음 장면부터 다시 돈다
export type ExhibitMode = 'auto' | 'manual';

type ControllerOptions = {
  sceneCount: number;
  idleMs: number;
  // 돌아가기를 누른 뒤 손이 마우스에서 떨어지며 생기는 입력을 무시하는 시간
  resumeGraceMs: number;
  run: (startAt: number, signal: AbortSignal, onScene: (index: number) => void) => Promise<void>;
  onMode: (mode: ExhibitMode) => void;
};

export function createExhibitController({ sceneCount, idleMs, resumeGraceMs, run, onMode }: ControllerOptions) {
  let tour: AbortController | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let currentScene = 0;
  let ignoreInputUntil = 0;

  const startTour = (startAt: number) => {
    tour = new AbortController();
    onMode('auto');
    run(startAt, tour.signal, (index) => {
      currentScene = index;
    }).catch(() => {});
  };

  const stopTour = () => {
    tour?.abort();
    tour = null;
  };

  const resumeFromNext = () => {
    clearTimeout(idleTimer);
    startTour((currentScene + 1) % sceneCount);
  };

  return {
    start() {
      startTour(0);
    },
    humanInput() {
      if (Date.now() < ignoreInputUntil) return;
      if (tour) {
        stopTour();
        onMode('manual');
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(resumeFromNext, idleMs);
    },
    resume() {
      if (tour) return;
      ignoreInputUntil = Date.now() + resumeGraceMs;
      resumeFromNext();
    },
    stop() {
      clearTimeout(idleTimer);
      stopTour();
    },
  };
}
