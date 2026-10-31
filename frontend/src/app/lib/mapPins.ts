// 2D·3D 지도 장비 핀의 크기·색. 핀은 지도와 1:1로 커지고 작아진다(사진을 확대·축소한 것처럼).
// three를 import하지 않는다 — 2D 지도와 첫 화면 번들에서도 쓴다.

// 처음 화면(층 전체가 보이는 상태)에서 핀 지름 = 지도 상자 폭의 2%.
// 휴대폰에서 약 2배 확대했을 때(지도 폭 약 660px에서 14px)가 자연스러웠던 비율이다
export const PIN_MAP_RATIO = 0.02;

// 일반 핀 : 선택 핀 : 선택 핀 고리 = 14 : 22 : 40 (예전 고정 px 비율)
export const PIN_SIZE_RATIO = { spotlight: 22 / 14, ring: 40 / 14 } as const;

// 핀이 아무리 작아도 누르는 영역은 이보다 줄지 않는다
export const MIN_PIN_HIT_SIZE = 28;

// 상태별 핀 색 — theme.css의 .map-marker-*와 같아야 한다(mapPins.test.ts가 확인)
export const PIN_COLORS = { available: '#16a34a', checked_out: '#dc2626', inactive: '#475569' } as const;

export function pinDiameter(mapWidthPx: number): number {
  return PIN_MAP_RATIO * mapWidthPx;
}

export function pinHitSize(diameterPx: number): number {
  return Math.max(MIN_PIN_HIT_SIZE, diameterPx);
}
