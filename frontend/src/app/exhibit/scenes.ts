// 학술제 전시 순환 대본. 앱 화면 3개를 자동으로 돈다
// 보안 실연(위조·재전송·변조)은 발표자가 터미널(tools/exhibit)에서 직접 보여 준다 — 앱 대본에는 없다
// 읽기 전용 — 대여·반납·저장 단추는 누르지 않는다(scenes.test.ts가 확인)
// 화면 문구를 바꾸면 여기 대상도 함께 고친다
import type { Scene, Step } from './player';

// 실물 비콘을 단 장비와 그 연출 기록(설계 메모 2026-11-09-exhibit-demo-mode)
const REAL_EQUIPMENT = '수액펌프-001';
const STAGED_USAGE = '#3251';

const CERTIFICATE_BODY = { selector: '[data-slot="dialog-body"]' };
// 지도는 1층으로 열린다
const FLOORS = [2, 3, 4, 5];

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
      // 시연 영상처럼 1층(처음 화면)부터 5층까지 층별 구역·장비 현황을 훑는다 — 첫 자막을 그대로 둔다
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
      { do: 'caption', text: '검증 증명서: 사용 기록과 블록체인 기록의 일치 여부 확인' },
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
      { do: 'caption', text: '장비 사용 데이터 기반 장비 가동률 분석 기능' },
      { do: 'point', target: { selector: 'button.staff-util-row' } },
      { do: 'wait', ms: 3000 },
      { do: 'caption', text: '하루 중 가장 바쁜 1시간의 가동률로 판정\n80% 이상: 추가 구매 검토 · 20% 미만: 유휴' },
      { do: 'wait', ms: 3500 },
      // 판정 자막을 그대로 둔 채 추가 구매 검토 종류를 연다. 7일 동안 그런 종류가 없으면 전체 장비 그대로 둔다
      { do: 'click', target: { selector: 'button.staff-util-row', text: '추가 구매 검토' }, optional: true },
      { do: 'wait', ms: 7000 },
    ],
  },
];
