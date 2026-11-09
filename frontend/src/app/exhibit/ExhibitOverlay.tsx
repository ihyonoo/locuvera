// 학술제 전시 모드 화면 층. 대본대로 앱을 조작하고, 관람객이 만지면 손을 뗀다
// 시연 영상처럼 장면마다 간지(번호·제목)로 열고, 단계마다 아래 자막으로 설명한다
// 간지·커서·클립·자막은 앱 위에 겹치며 클릭을 가로채지 않는다
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import '../../styles/exhibit.css';
import { type ExhibitMode, createExhibitController } from './controller';
import { abortError } from './dom';
import { type HumanEventCheck, watchHumanInput } from './humanInput';
import { type DemoRole, type Scene, runExhibit } from './player';
import { EXHIBIT_SCENES } from './scenes';
import { ensureDemoSession } from './session';

const IDLE_MS = 60_000;
// 돌아가기를 누른 뒤 손이 마우스에서 떨어지며 생기는 움직임은 사람 개입으로 보지 않는다
const RESUME_GRACE_MS = 2_000;
// 간지를 띄워 두는 최소 시간. 화면 이동·로그인·로딩은 그 뒤에서 끝난다
const CARD_MS = 1_400;
// exhibit.css의 간지·클립 페이드 시간과 맞춘다
const FADE_MS = 400;
// 커서 이동 시간은 거리에 따라 늘어난다
const CURSOR_MIN_MS = 380;
const CURSOR_MAX_MS = 950;
const CURSOR_MS_PER_PX = 0.45;
const PRESS_MS = 150;
const SCROLL_POLL_MS = 120;
const SCROLL_SETTLE_MAX_MS = 2_000;
// 영상이 멈춰 끝나지 않아도 순환은 계속된다
const CLIP_MAX_MS = 120_000;

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
  const [clip, setClip] = useState<string | null>(null);
  const finishClip = useRef<(() => void) | null>(null);
  const resumeTour = useRef<() => void>(() => {});
  // 순환은 화면 수명 동안 한 번만 만든다 — 첫 렌더의 값으로 고정
  const setup = useRef({ navigate, scenes, ensureSession, isHumanEvent, idleMs, cardMs });

  useEffect(() => {
    const config = setup.current;
    const fadeMs = Math.min(FADE_MS, config.cardMs);
    let cardOn = false;
    let cursorAt: { x: number; y: number } | null = null;

    // 간지가 떠 있으면 걷어 낸다 — 화면에 무언가를 보여 주는 단계마다 먼저 부른다
    const reveal = async (signal: AbortSignal) => {
      if (!cardOn) return;
      cardOn = false;
      setCard((prev) => (prev ? { ...prev, on: false } : prev));
      await sleep(fadeMs, signal);
    };

    // 간지가 앞 장면(끝난 클립의 마지막 화면 포함) 위로 덮인 뒤에 그 아래를 비운다
    const sceneStart = async (index: number, scene: Scene, signal: AbortSignal) => {
      cardOn = true;
      setCaption('');
      setCard({ no: String(index + 1).padStart(2, '0'), title: scene.title, on: true });
      await sleep(fadeMs, signal);
      setClip(null);
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

    // 클립을 간지 뒤에 먼저 띄우고 간지를 걷는다. 끝나면 마지막 화면에 멈춘 채 다음 간지를 기다린다
    const playClip = (src: string, signal: AbortSignal, text?: string) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(guard);
          signal.removeEventListener('abort', finish);
          finishClip.current = null;
          resolve();
        };
        const guard = setTimeout(finish, CLIP_MAX_MS);
        finishClip.current = finish;
        signal.addEventListener('abort', finish, { once: true });
        setClip(src);
        setCaption(text ?? '');
        reveal(signal).catch(() => {});
      });

    const controller = createExhibitController({
      sceneCount: config.scenes.length,
      idleMs: config.idleMs,
      resumeGraceMs: RESUME_GRACE_MS,
      onMode: (next) => {
        setMode(next);
        if (next === 'manual') {
          cardOn = false;
          cursorAt = null;
          setCard(null);
          setCaption('');
          setCursor(null);
          setClip(null);
        }
      },
      run: (startAt, signal, onScene) =>
        runExhibit(config.scenes, startAt, signal, {
          navigate: config.navigate,
          sleep,
          pointAt,
          press,
          playClip,
          sceneStart,
          caption: showCaption,
          beforeScene: async (scene) => {
            if (scene.role) await config.ensureSession(scene.role);
          },
          onScene: (index) => onScene(index),
        }),
    });

    resumeTour.current = () => controller.resume();
    controller.start();
    const stopWatching = watchHumanInput(window, () => controller.humanInput(), config.isHumanEvent);
    return () => {
      stopWatching();
      controller.stop();
    };
  }, []);

  const idleSec = Math.round(idleMs / 1000);
  const auto = mode === 'auto';

  return (
    <div className="exhibit-layer">
      {auto && clip ? (
        <div className="exhibit-clip">
          <video
            key={clip}
            data-testid="exhibit-clip"
            src={clip}
            autoPlay
            muted
            playsInline
            onEnded={() => finishClip.current?.()}
            onError={() => finishClip.current?.()}
          />
        </div>
      ) : null}
      {auto && card ? (
        <div data-testid="exhibit-card" className={card.on ? 'exhibit-card exhibit-card--on' : 'exhibit-card'}>
          <div className="exhibit-card__no">{card.no}</div>
          <div className="exhibit-card__title">{card.title}</div>
        </div>
      ) : null}
      {auto && cursor && !clip ? (
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
      {!auto ? (
        <div className="exhibit-banner" role="status">
          <span className="exhibit-banner__dot" aria-hidden="true" />
          <span>직접 조작 중 · {idleSec}초 동안 입력이 없으면 자동 시연으로 돌아갑니다</span>
          <button type="button" className="exhibit-banner__resume" onClick={() => resumeTour.current()}>
            자동 시연으로 돌아가기
          </button>
        </div>
      ) : null}
    </div>
  );
}
