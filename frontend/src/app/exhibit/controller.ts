// 자동 순환과 직접 조작을 오가는 상태 기계
// 사람이 만지면 순환을 끊고, idleMs 동안 입력이 없으면 다음 장면부터 다시 돈다
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

  return {
    start() {
      startTour(0);
    },
    humanInput() {
      if (tour) {
        stopTour();
        onMode('manual');
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        startTour((currentScene + 1) % sceneCount);
      }, idleMs);
    },
    stop() {
      clearTimeout(idleTimer);
      stopTour();
    },
  };
}
