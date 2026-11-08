// 관람객이 화면을 만졌는지 감지한다
// 대본의 click()·input 이벤트는 isTrusted가 false라 걸리지 않는다
const HUMAN_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
// 마우스가 이만큼(px) 움직여야 사람으로 본다 — 책상 진동 같은 떨림은 무시
const MOVE_THRESHOLD_PX = 8;

export type HumanEventCheck = (event: Event) => boolean;

const isTrustedEvent: HumanEventCheck = (event) => event.isTrusted;

export function watchHumanInput(
  target: Window,
  onHuman: () => void,
  isHumanEvent: HumanEventCheck = isTrustedEvent,
): () => void {
  let anchor: { x: number; y: number } | null = null;

  const onEvent = (event: Event) => {
    if (isHumanEvent(event)) onHuman();
  };
  const onMove = (event: Event) => {
    if (!isHumanEvent(event)) return;
    const { clientX, clientY } = event as MouseEvent;
    if (!anchor) {
      anchor = { x: clientX, y: clientY };
      return;
    }
    if (Math.hypot(clientX - anchor.x, clientY - anchor.y) >= MOVE_THRESHOLD_PX) {
      anchor = { x: clientX, y: clientY };
      onHuman();
    }
  };

  const options = { capture: true, passive: true };
  for (const type of HUMAN_EVENTS) target.addEventListener(type, onEvent, options);
  target.addEventListener('pointermove', onMove, options);

  return () => {
    for (const type of HUMAN_EVENTS) target.removeEventListener(type, onEvent, options);
    target.removeEventListener('pointermove', onMove, options);
  };
}
