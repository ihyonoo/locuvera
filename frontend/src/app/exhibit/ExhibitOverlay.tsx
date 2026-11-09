// 학술제 전시 모드 화면 층. 대본대로 앱 화면 4개를 돌며, '직접 조작하기'를 누르면 손을 뗀다
// 자동 시연 중에는 투명한 막이 앱을 덮어 관람객의 마우스·클릭이 대본을 흐트러뜨리지 않는다
// 시연 영상처럼 장면마다 간지(번호·제목)로 열고, 단계마다 아래 자막으로 설명한다
// '일시정지'는 지금 화면에 멈춰 세우고(pauseGate), 아래 진행도바가 몇 번째 장면인지 보여 준다
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import '../../styles/exhibit.css';
import { type ExhibitMode, createExhibitController } from './controller';
import { abortError } from './dom';
import { type HumanEventCheck, watchHumanInput } from './humanInput';
import { type PauseGate, createPauseGate } from './pauseGate';
import { type DemoRole, type Scene, runExhibit } from './player';
import { EXHIBIT_SCENES } from './scenes';
import { ensureDemoSession } from './session';

const IDLE_MS = 60_000;
// 자동 시연 중 실제 마우스 포인터는 움직일 때만 이만큼 보이고 다시 숨는다 — 영상처럼 보이게
const POINTER_SHOW_MS = 2_500;
// 간지를 띄워 두는 최소 시간. 화면 이동·로그인·로딩은 그 뒤에서 끝난다
const CARD_MS = 1_400;
// exhibit.css의 간지 페이드 시간과 맞춘다
const FADE_MS = 400;
// 커서 이동 시간은 거리에 따라 늘어난다
const CURSOR_MIN_MS = 380;
const CURSOR_MAX_MS = 950;
const CURSOR_MS_PER_PX = 0.45;
const PRESS_MS = 150;
const SCROLL_POLL_MS = 120;
const SCROLL_SETTLE_MAX_MS = 2_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type Cursor = { x: number; y: number; ms: number };
type Card = { no: string; title: string; on: boolean };

type ExhibitOverlayProps = {
  navigate: (to: string) => void | Promise<void>;
  scenes?: Scene[];
  ensureSession?: (role: DemoRole) => Promise<void>;
  isHumanEvent?: HumanEventCheck;
  idleMs?: number;
  cardMs?: number;
};

export default function ExhibitOverlay({
  navigate,
  scenes = EXHIBIT_SCENES,
  ensureSession = ensureDemoSession,
  isHumanEvent,
  idleMs = IDLE_MS,
  cardMs = CARD_MS,
}: ExhibitOverlayProps) {
  const [mode, setMode] = useState<ExhibitMode>('auto');
  const [card, setCard] = useState<Card | null>(null);
  const [caption, setCaption] = useState('');
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [pressed, setPressed] = useState(false);
  const [paused, setPaused] = useState(false);
  // 진행도바가 가리키는 지금 장면(0부터)
  const [sceneIndex, setSceneIndex] = useState(0);
  const tourControls = useRef({ takeOver: () => {}, resume: () => {} });
  const shield = useRef<HTMLDivElement>(null);
  const [pointerStill, setPointerStill] = useState(true);
  const pointerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 멈춤 문은 화면 수명 동안 하나만 둔다
  const gateRef = useRef<PauseGate | null>(null);
  if (gateRef.current === null) gateRef.current = createPauseGate();
  // 순환은 화면 수명 동안 한 번만 만든다 — 첫 렌더의 값으로 고정
  const setup = useRef({ navigate, scenes, ensureSession, isHumanEvent, idleMs, cardMs });

  useEffect(() => {
    const config = setup.current;
    const gate = gateRef.current!;
    const fadeMs = Math.min(FADE_MS, config.cardMs);
    let cardOn = false;
    let cursorAt: { x: number; y: number } | null = null;

    // 멈춤이면 '계속'이나 직접 조작 전환까지 기다렸다 다음 단계로 — 매 단계 경계에서 지난다
    const tourSleep = async (ms: number, signal: AbortSignal) => {
      await sleep(ms, signal);
      await gate.wait(signal);
    };

    // 간지가 떠 있으면 걷어 낸다 — 화면에 무언가를 보여 주는 단계마다 먼저 부른다
    const reveal = async (signal: AbortSignal) => {
      if (!cardOn) return;
      cardOn = false;
      setCard((prev) => (prev ? { ...prev, on: false } : prev));
      await sleep(fadeMs, signal);
    };

    // 간지가 앞 장면 위로 덮인 뒤에 그 아래를 비운다
    const sceneStart = async (index: number, scene: Scene, signal: AbortSignal) => {
      cardOn = true;
      setCaption('');
      setCard({ no: String(index + 1).padStart(2, '0'), title: scene.title, on: true });
      await sleep(fadeMs, signal);
      await sleep(Math.max(0, config.cardMs - fadeMs), signal);
    };

    const pointAt = async (el: HTMLElement, signal: AbortSignal) => {
      el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      // 부드러운 스크롤이 멈춘 뒤에 위치를 잰다 — 도중에 재면 커서가 엉뚱한 곳에 선다
      let lastTop = el.getBoundingClientRect().top;
      for (let waited = 0; waited < SCROLL_SETTLE_MAX_MS; waited += SCROLL_POLL_MS) {
        await sleep(SCROLL_POLL_MS, signal);
        const top = el.getBoundingClientRect().top;
        if (top === lastTop) break;
        lastTop = top;
      }
      await reveal(signal);
      const rect = el.getBoundingClientRect();
      const next = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      // 처음 나타날 때는 화면 가운데에서 출발한다
      const from = cursorAt ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      if (!cursorAt) {
        setCursor({ ...from, ms: 0 });
        await sleep(30, signal);
      }
      const ms = Math.round(
        Math.min(
          CURSOR_MAX_MS,
          Math.max(CURSOR_MIN_MS, CURSOR_MIN_MS + Math.hypot(next.x - from.x, next.y - from.y) * CURSOR_MS_PER_PX),
        ),
      );
      cursorAt = next;
      setCursor({ ...next, ms });
      await sleep(ms + 40, signal);
    };

    const press = async (signal: AbortSignal) => {
      setPressed(true);
      try {
        await sleep(PRESS_MS, signal);
      } finally {
        setPressed(false);
      }
    };

    const showCaption = async (text: string, signal: AbortSignal) => {
      await reveal(signal);
      setCaption(text);
    };

    const controller = createExhibitController({
      sceneCount: config.scenes.length,
      idleMs: config.idleMs,
      onMode: (next) => {
        setMode(next);
        // 새 순환은 멈춤 없이 시작하고, 직접 조작으로 넘어갈 때도 멈춤을 푼다
        gate.resume();
        setPaused(false);
        if (next === 'manual') {
          cardOn = false;
          cursorAt = null;
          setCard(null);
          setCaption('');
          setCursor(null);
        }
      },
      run: (startAt, signal, onScene) =>
        runExhibit(config.scenes, startAt, signal, {
          navigate: config.navigate,
          sleep: tourSleep,
          pointAt,
          press,
          sceneStart,
          caption: showCaption,
          beforeScene: async (scene) => {
            if (scene.role) await config.ensureSession(scene.role);
          },
          onScene: (index) => {
            setSceneIndex(index);
            onScene(index);
          },
        }),
    });

    tourControls.current = { takeOver: () => controller.takeOver(), resume: () => controller.resume() };
    controller.start();
    const stopWatching = watchHumanInput(window, () => controller.humanInput(), config.isHumanEvent);
    return () => {
      stopWatching();
      controller.stop();
    };
  }, []);

  const idleSec = Math.round(idleMs / 1000);
  const auto = mode === 'auto';
  const sceneCount = scenes.length;

  // 막 위의 휠은 뒤 페이지를 굴리지 않게 막는다(React onWheel은 passive라 직접 붙인다)
  useEffect(() => {
    const el = shield.current;
    if (!el) return;
    const block = (event: Event) => event.preventDefault();
    el.addEventListener('wheel', block, { passive: false });
    el.addEventListener('touchmove', block, { passive: false });
    return () => {
      el.removeEventListener('wheel', block);
      el.removeEventListener('touchmove', block);
    };
  }, [auto]);

  useEffect(() => () => clearTimeout(pointerTimer.current), []);

  const showPointer = () => {
    setPointerStill(false);
    clearTimeout(pointerTimer.current);
    pointerTimer.current = setTimeout(() => setPointerStill(true), POINTER_SHOW_MS);
  };

  const togglePause = () => {
    const gate = gateRef.current!;
    if (gate.paused()) {
      gate.resume();
      setPaused(false);
    } else {
      gate.pause();
      setPaused(true);
    }
  };

  return (
    <div className="exhibit-layer">
      {auto ? (
        <div
          ref={shield}
          data-testid="exhibit-shield"
          className={pointerStill ? 'exhibit-shield exhibit-shield--still' : 'exhibit-shield'}
          onPointerMove={showPointer}
        />
      ) : null}
      {auto && card ? (
        <div data-testid="exhibit-card" className={card.on ? 'exhibit-card exhibit-card--on' : 'exhibit-card'}>
          <div className="exhibit-card__no">{card.no}</div>
          <div className="exhibit-card__title">{card.title}</div>
        </div>
      ) : null}
      {auto && cursor ? (
        <div
          data-testid="exhibit-cursor"
          className={pressed ? 'exhibit-cursor exhibit-cursor--press' : 'exhibit-cursor'}
          style={
            {
              transform: `translate(${cursor.x}px, ${cursor.y}px)`,
              '--exhibit-move': `${cursor.ms}ms`,
            } as CSSProperties
          }
          aria-hidden="true"
        >
          <span className="exhibit-cursor__glow" />
          <svg viewBox="0 0 28 28">
            <path d="M5 3 L5 23 L10.2 18.3 L13.6 25.6 L17 24.1 L13.6 16.9 L20.6 16.6 Z" />
          </svg>
        </div>
      ) : null}
      {auto && caption ? (
        <div key={caption} data-testid="exhibit-caption" className="exhibit-caption" role="status">
          {caption}
        </div>
      ) : null}
      {auto ? (
        <div
          data-testid="exhibit-progress"
          className="exhibit-progress"
          role="progressbar"
          aria-label="시연 진행도"
          aria-valuemin={0}
          aria-valuemax={sceneCount}
          aria-valuenow={sceneIndex + 1}
        >
          <span className="exhibit-progress__fill" style={{ width: `${((sceneIndex + 1) / sceneCount) * 100}%` }} />
        </div>
      ) : null}
      {auto ? (
        <div className="exhibit-controls">
          <button type="button" className="exhibit-ctl" onClick={togglePause}>
            {paused ? '계속' : '일시정지'}
          </button>
          <button type="button" className="exhibit-ctl" onClick={() => tourControls.current.takeOver()}>
            직접 조작하기
          </button>
        </div>
      ) : (
        <div className="exhibit-banner" role="status">
          <span className="exhibit-banner__dot" aria-hidden="true" />
          <span>직접 조작 중 · {idleSec}초 동안 입력이 없으면 자동 시연으로 돌아갑니다</span>
          <button type="button" className="exhibit-banner__resume" onClick={() => tourControls.current.resume()}>
            자동 시연으로 돌아가기
          </button>
        </div>
      )}
    </div>
  );
}
