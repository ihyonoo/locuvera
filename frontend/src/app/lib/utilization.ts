// GET /admin/utilization 응답 타입과 표시 규칙

export const PERIOD_OPTIONS = [7, 30, 90] as const;
export type PeriodDays = (typeof PERIOD_OPTIONS)[number];

export type UtilizationVerdict = 'shortage' | 'essential' | 'idle' | 'adequate';

export type UtilizationUnit = {
  tag_id: string;
  equipment_name: string;
  utilization: number;
  checkout_count: number;
};

export type UtilizationType = {
  equipment_type: string;
  unit_count: number;
  utilization: number;
  peak_hour: number | null;
  peak_utilization: number;
  checkout_count: number;
  verdict: UtilizationVerdict;
  additional_units: number | null;
  units: UtilizationUnit[];
};

// [요일 0=월][시 0~23], 값은 0~1
export type Heatmap = number[][];

// 평일(월~금)·주말(토·일) 시간대 가동률, 각 24개(0~23시), 값은 0~1
export type HourlyProfile = { weekday: number[]; weekend: number[] };

export type UtilizationResponse = {
  ok: boolean;
  period: { days: PeriodDays; start: string; end: string };
  summary: { utilization: number; shortage_type_count: number; idle_type_count: number };
  types: UtilizationType[];
  heatmap: { all: Heatmap; by_type: Record<string, Heatmap> };
  hourly: { all: HourlyProfile; by_type: Record<string, HourlyProfile> };
};

const VERDICT_LABELS: Record<UtilizationVerdict, string> = {
  shortage: '추가 구매 검토',
  essential: '필수 비치',
  idle: '유휴',
  adequate: '적정',
};

export function verdictLabel(verdict: UtilizationVerdict): string {
  return VERDICT_LABELS[verdict];
}

// 판정 임계값이 정수 %라서 반올림하지 않고 버린다 (39.6%를 40%로 보이지 않게)
// 1e-9는 0.29 * 100 = 28.999… 같은 부동소수점 오차 보정
export function formatPercent(ratio: number): string {
  return `${Math.floor(ratio * 100 + 1e-9)}%`;
}

export function recommendation(item: UtilizationType): string | null {
  switch (item.verdict) {
    case 'shortage':
      return `${item.peak_hour}시대 가동률 ${formatPercent(item.peak_utilization)} — ${item.additional_units}대 추가 검토`;
    case 'idle':
      return item.peak_hour === null
        ? '기간 중 대여 없음 — 재배치 검토'
        : `가장 바쁜 ${item.peak_hour}시대에도 ${formatPercent(item.peak_utilization)} — 재배치 검토`;
    case 'essential':
      return '사용 빈도와 무관하게 비치 유지';
    default:
      return null;
  }
}
