// 학술제 전시 모드 화면 층. 대본대로 앱을 조작하고, 관람객이 만지면 손을 뗀다
// 커서·클립·안내 막대는 앱 위에 겹치며 클릭을 가로채지 않는다
import { useEffect, useRef, useState } from 'react';
import '../../styles/exhibit.css';
import { type ExhibitMode, createExhibitController } from './controller';
import { abortError } from './dom';
import { type HumanEventCheck, watchHumanInput } from './humanInput';
import { type DemoRole, type Scene, runExhibit } from './player';
import { EXHIBIT_SCENES } from './scenes';
import { ensureDemoSession } from './session';

const IDLE_MS = 60_000;
// exhibit.css의 커서 이동 시간과 맞춘다
const CURSOR_MOVE_MS = 700;
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

type ExhibitOverlayProps = {
  navigate: (to: string) => void | Promise<void>;
  scenes?: Scene[];
  ensureSession?: (role: DemoRole) => Promise<void>;
  isHumanEvent?: HumanEventCheck;
  idleMs?: number;
};

export default function ExhibitOverlay({
  navigate,
  scenes = EXHIBIT_SCENES,
  ensureSession = ensureDemoSession,
  isHumanEvent,
  idleMs = IDLE_MS,
}: ExhibitOverlayProps) {
  const [mode, setMode] = useState<ExhibitMode>('auto');
  const [title, setTitle] = useState('');
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [clip, setClip] = useState<string | null>(null);
  const finishClip = useRef<(() => void) | null>(null);
  // 순환은 화면 수명 동안 한 번만 만든다 — 첫 렌더의 값으로 고정
  const setup = useRef({ navigate, scenes, ensureSession, isHumanEvent, idleMs });

  useEffect(() => {
    const config = setup.current;

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
      const rect = el.getBoundingClientRect();
      setCursor({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      await sleep(CURSOR_MOVE_MS, signal);
    };

    const playClip = (src: string, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(guard);
          signal.removeEventListener('abort', finish);
          finishClip.current = null;
          setClip(null);
          resolve();
        };
        const guard = setTimeout(finish, CLIP_MAX_MS);
        finishClip.current = finish;
        signal.addEventListener('abort', finish, { once: true });
        setClip(src);
      });

    const controller = createExhibitController({
      sceneCount: config.scenes.length,
      idleMs: config.idleMs,
      onMode: (next) => {
        setMode(next);
        if (next === 'manual') setCursor(null);
      },
      run: (startAt, signal, onScene) =>
        runExhibit(config.scenes, startAt, signal, {
          navigate: config.navigate,
          sleep,
          pointAt,
          playClip,
          beforeScene: async (scene) => {
            if (scene.role) await config.ensureSession(scene.role);
          },
          onScene: (index, scene) => {
            onScene(index);
            setTitle(scene.title);
          },
        }),
    });

    controller.start();
    const stopWatching = watchHumanInput(window, () => controller.humanInput(), config.isHumanEvent);
    return () => {
      stopWatching();
      controller.stop();
    };
  }, []);

  const idleSec = Math.round(idleMs / 1000);

  return (
    <div className="exhibit-layer">
      {mode === 'auto' && clip ? (
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
      {mode === 'auto' && cursor && !clip ? (
        <div
          data-testid="exhibit-cursor"
          className="exhibit-cursor"
          style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" width="30" height="30">
            <path d="M4 2.5 L4 19.5 L8.6 15.3 L11.6 22 L14.6 20.7 L11.7 14.1 L18 14.1 Z" />
          </svg>
        </div>
      ) : null}
      <div className={`exhibit-banner exhibit-banner--${mode}`} role="status">
        <span className="exhibit-banner__dot" aria-hidden="true" />
        {mode === 'auto' ? (
          <>
            {title ? <strong className="exhibit-banner__title">{title}</strong> : null}
            <span>자동 시연 중 · 마우스를 움직이면 직접 조작할 수 있습니다</span>
          </>
        ) : (
          <span>직접 조작 중 · {idleSec}초 동안 입력이 없으면 자동 시연으로 돌아갑니다</span>
        )}
      </div>
    </div>
  );
}
