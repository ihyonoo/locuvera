// 학술제 전시 순환 대본. 앱 화면과 보안 실연 클립을 번갈아 재생한다
// 읽기 전용 — 대여·반납·저장 단추는 누르지 않는다(scenes.test.ts가 확인)
// 화면 문구를 바꾸면 여기 대상도 함께 고친다
import type { Scene } from './player';

// 실물 비콘을 단 장비와 그 연출 기록(설계 메모 2026-11-09-exhibit-demo-mode)
const REAL_EQUIPMENT = '수액펌프-001';
const STAGED_USAGE = '#3251';

// tools/exhibit/ 스크립트를 운영 서버에 실제로 실행해 찍은 영상
export const SECURITY_CLIPS = [
  { id: 'forge-ingest', title: '측위 보고 위조 차단', src: '/exhibit/forge-ingest.mp4' },
  { id: 'replay-nfc', title: 'NFC 태그 복제·재전송 차단', src: '/exhibit/replay-nfc.mp4' },
  { id: 'tamper-detect', title: '사용 이력 변조 탐지', src: '/exhibit/tamper-detect.mp4' },
] as const;

const clipScene = (clip: (typeof SECURITY_CLIPS)[number]): Scene => ({
  id: clip.id,
  title: clip.title,
  steps: [{ do: 'clip', src: clip.src }],
});

const CERTIFICATE_BODY = { selector: '[data-slot="dialog-body"]' };

export const EXHIBIT_SCENES: Scene[] = [
  {
    id: 'location',
    title: '실시간 장비 위치 조회',
    role: 'staff',
    steps: [
      { do: 'go', to: '/equipment' },
      { do: 'wait', ms: 2500 },
      // 실물 리더 구역만 밝힌다
      { do: 'click', target: { selector: 'label.staff-switch', text: '시뮬레이션 숨김' } },
      { do: 'wait', ms: 2500 },
      { do: 'type', target: { selector: 'input[aria-label="장비 검색"]' }, text: REAL_EQUIPMENT },
      { do: 'wait', ms: 1200 },
      { do: 'click', target: { selector: 'button.staff-row', text: REAL_EQUIPMENT } },
      // 현장에서 비콘을 옮기면 이 사이에 위치가 바뀐다
      { do: 'wait', ms: 15000 },
    ],
  },
  clipScene(SECURITY_CLIPS[0]),
  {
    id: 'verification',
    title: '사용 이력 조회·무결성 검증',
    role: 'admin',
    steps: [
      { do: 'go', to: '/verification' },
      { do: 'type', target: { selector: 'input[placeholder="장비명 또는 태그 ID"]' }, text: REAL_EQUIPMENT },
      // 첫 목록을 검증하는 동안에는 조회 단추가 꺼져 있다
      { do: 'click', target: { selector: 'button[type="submit"]:not([disabled])', text: '조회' } },
      { do: 'point', target: { selector: 'button.staff-usage-row', text: STAGED_USAGE } },
      { do: 'wait', ms: 2500 },
      { do: 'click', target: { selector: 'button.staff-usage-row', text: STAGED_USAGE } },
      { do: 'wait', ms: 3000 },
      { do: 'scroll', target: CERTIFICATE_BODY, by: 420 },
      { do: 'wait', ms: 2500 },
      { do: 'scroll', target: CERTIFICATE_BODY, by: 420 },
      { do: 'wait', ms: 2500 },
      { do: 'scroll', target: CERTIFICATE_BODY, by: 600 },
      { do: 'wait', ms: 3000 },
      { do: 'click', target: { selector: '[data-slot="dialog-close"]' } },
      { do: 'wait', ms: 1500 },
    ],
  },
  clipScene(SECURITY_CLIPS[1]),
  {
    id: 'utilization',
    title: '장비 가동률 분석',
    role: 'admin',
    steps: [
      { do: 'go', to: '/admin/utilization' },
      { do: 'point', target: { selector: 'button.staff-util-row' } },
      { do: 'wait', ms: 4000 },
      // 7일 동안 추가 구매 검토 종류가 없으면 전체 장비 그대로 둔다
      { do: 'click', target: { selector: 'button.staff-util-row', text: '추가 구매 검토' }, optional: true },
      { do: 'wait', ms: 10000 },
    ],
  },
  clipScene(SECURITY_CLIPS[2]),
  {
    id: 'devices',
    title: '리더·태그 상태 모니터링',
    role: 'admin',
    steps: [
      { do: 'go', to: '/admin/devices' },
      { do: 'point', target: { selector: 'h2.staff-panel__title', text: '리더' } },
      { do: 'wait', ms: 3000 },
      // 잔량 20% 미만 태그의 교체 알림
      { do: 'point', target: { selector: '.staff-battery-alert' }, optional: true },
      { do: 'wait', ms: 4000 },
      // 실물 리더 2대와 실물 비콘만 남긴다
      { do: 'click', target: { selector: 'label.staff-switch', text: '시뮬레이션 데이터 숨기기' } },
      { do: 'wait', ms: 1500 },
      { do: 'point', target: { selector: '.staff-battery' }, optional: true },
      { do: 'wait', ms: 6000 },
    ],
  },
];
