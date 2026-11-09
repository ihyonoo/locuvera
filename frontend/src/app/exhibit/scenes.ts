// 학술제 전시 순환 대본. 앱 화면 4개를 돈 뒤 보안 실연 클립 3개를 맨 뒤에 이어서 재생한다
// 읽기 전용 — 대여·반납·저장 단추는 누르지 않는다(scenes.test.ts가 확인)
// 화면 문구를 바꾸면 여기 대상도 함께 고친다
import type { Scene, Step } from './player';

// 실물 비콘을 단 장비와 그 연출 기록(설계 메모 2026-11-09-exhibit-demo-mode)
const REAL_EQUIPMENT = '수액펌프-001';
const STAGED_USAGE = '#3251';

// tools/exhibit/ 스크립트를 운영 서버에 실제로 실행해 찍은 영상
export const SECURITY_CLIPS = [
  {
    id: 'forge-ingest',
    title: '측위 보고 위조 차단',
    src: '/exhibit/forge-ingest.mp4',
    caption: '운영 서버에 위조 측위 보고 실제 전송\n서명 없음·위조 서명·미등록 리더 모두 거부',
  },
  {
    id: 'replay-nfc',
    title: 'NFC 태그 복제·재전송 차단',
    src: '/exhibit/replay-nfc.mp4',
    caption: '이미 사용된 NFC 태깅 URL 재전송·카운터 위조\n칩 카운터·CMAC 검증으로 거부, 서버 감사 기록 저장',
  },
  {
    id: 'tamper-detect',
    title: '사용 이력 변조 탐지',
    src: '/exhibit/tamper-detect.mp4',
    caption: 'DB 사용 이력의 반납 시각 변조\n블록체인 기록과 대조해 즉시 탐지 후 원상 복구',
  },
] as const;

const clipScene = (clip: (typeof SECURITY_CLIPS)[number]): Scene => ({
  id: clip.id,
  title: clip.title,
  steps: [{ do: 'clip', src: clip.src, caption: clip.caption }],
});

const CERTIFICATE_BODY = { selector: '[data-slot="dialog-body"]' };
const FLOORS = [1, 2, 3, 4, 5];

export const EXHIBIT_SCENES: Scene[] = [
  {
    id: 'location',
    title: '실시간 장비 위치 조회',
    role: 'staff',
    steps: [
      { do: 'go', to: '/equipment' },
      // 3D 지도가 그려질 때까지 간지 뒤에서 기다린다
      { do: 'ready', target: { selector: 'button.staff-floor[aria-label="1층"]' } },
      { do: 'wait', ms: 1500 },
      { do: 'caption', text: '병원 도면 위 장비 위치 실시간 표시\n초록: 사용 가능 · 빨강: 대여 중' },
      { do: 'wait', ms: 3000 },
      // 시연 영상처럼 1층부터 5층까지 층별 구역·장비 현황을 훑는다
      { do: 'caption', text: '층별 구역·장비 현황 조회' },
      ...FLOORS.flatMap((floor): Step[] => [
        { do: 'click', target: { selector: `button.staff-floor[aria-label="${floor}층"]` } },
        { do: 'wait', ms: 1600 },
      ]),
      { do: 'caption', text: '장비명 검색' },
      { do: 'type', target: { selector: 'input[aria-label="장비 검색"]' }, text: REAL_EQUIPMENT },
      { do: 'wait', ms: 800 },
      { do: 'caption', text: `${REAL_EQUIPMENT} 선택 시 해당 층 도면에서 위치 강조` },
      { do: 'click', target: { selector: 'button.staff-row', text: REAL_EQUIPMENT } },
      { do: 'wait', ms: 4000 },
      // 현장에서 비콘을 옮기면 이 사이에 위치가 바뀐다
      {
        do: 'caption',
        text: '실물 BLE 비콘 부착 장비 · 리더 신호 세기로 구역 판정\n비콘을 옮기면 위치가 실시간으로 바뀜',
      },
      { do: 'wait', ms: 11000 },
    ],
  },
  {
    id: 'verification',
    title: '사용 이력 조회·무결성 검증',
    role: 'admin',
    steps: [
      { do: 'go', to: '/verification' },
      // 첫 목록을 검증하는 동안에는 조회 단추가 꺼져 있다
      { do: 'ready', target: { selector: 'button[type="submit"]:not([disabled])', text: '조회' } },
      { do: 'caption', text: '장비별 사용 이력 조회' },
      { do: 'type', target: { selector: 'input[placeholder="장비명 또는 태그 ID"]' }, text: REAL_EQUIPMENT },
      { do: 'click', target: { selector: 'button[type="submit"]:not([disabled])', text: '조회' } },
      { do: 'caption', text: '이력마다 블록체인 기록과 대조한 무결성 검증 결과 표시' },
      { do: 'point', target: { selector: 'button.staff-usage-row', text: STAGED_USAGE } },
      { do: 'wait', ms: 3000 },
      { do: 'caption', text: '검증 증명서: 사용 기록·온체인 원문·머클 루트 검증 결과' },
      { do: 'click', target: { selector: 'button.staff-usage-row', text: STAGED_USAGE } },
      { do: 'wait', ms: 2500 },
      { do: 'scroll', target: CERTIFICATE_BODY, by: 420 },
      { do: 'wait', ms: 2500 },
      { do: 'scroll', target: CERTIFICATE_BODY, by: 420 },
      { do: 'wait', ms: 2500 },
      { do: 'scroll', target: CERTIFICATE_BODY, by: 600 },
      { do: 'wait', ms: 3000 },
      { do: 'click', target: { selector: '[data-slot="dialog-close"]' } },
      { do: 'wait', ms: 1000 },
    ],
  },
  {
    id: 'utilization',
    title: '장비 가동률 분석',
    role: 'admin',
    steps: [
      { do: 'go', to: '/admin/utilization' },
      { do: 'ready', target: { selector: 'button.staff-util-row' } },
      { do: 'caption', text: '최근 7일 사용 이력 기준 장비 종류별 가동률 집계' },
      { do: 'point', target: { selector: 'button.staff-util-row' } },
      { do: 'wait', ms: 3000 },
      { do: 'caption', text: '하루 중 가장 바쁜 1시간의 가동률로 판정\n80% 이상: 추가 구매 검토 · 20% 미만: 유휴' },
      { do: 'wait', ms: 3500 },
      // 7일 동안 추가 구매 검토 종류가 없으면 전체 장비 그대로 둔다
      { do: 'caption', text: '추가 구매 검토 종류 선택: 평일·주말 시간대별 가동률' },
      { do: 'click', target: { selector: 'button.staff-util-row', text: '추가 구매 검토' }, optional: true },
      { do: 'wait', ms: 7000 },
    ],
  },
  {
    id: 'devices',
    title: '리더·태그 상태 모니터링',
    role: 'admin',
    steps: [
      { do: 'go', to: '/admin/devices' },
      { do: 'ready', target: { selector: 'h2.staff-panel__title', text: '리더' } },
      { do: 'caption', text: '리더 연결·태그 수신 상태 실시간 감시' },
      { do: 'point', target: { selector: 'h2.staff-panel__title', text: '리더' } },
      { do: 'wait', ms: 2500 },
      // 잔량 20% 미만 태그의 교체 알림
      { do: 'caption', text: '비콘 배터리 잔량 표시 · 20% 미만 시 교체 알림' },
      { do: 'point', target: { selector: '.staff-battery-alert' }, optional: true },
      { do: 'wait', ms: 3500 },
      // 실물 리더 2대와 실물 비콘만 남긴다
      { do: 'caption', text: '실물 리더 2대·실물 비콘 상태만 보기' },
      { do: 'click', target: { selector: 'label.staff-switch', text: '시뮬레이션 데이터 숨기기' } },
      { do: 'wait', ms: 1500 },
      { do: 'point', target: { selector: '.staff-battery' }, optional: true },
      { do: 'wait', ms: 5000 },
    ],
  },
  ...SECURITY_CLIPS.map(clipScene),
];
