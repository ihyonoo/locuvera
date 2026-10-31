import { describe, expect, it } from 'vitest';
import { formatPercent, recommendation, verdictLabel, type UtilizationType } from './utilization';

function typeItem(overrides: Partial<UtilizationType>): UtilizationType {
  return {
    equipment_type: '수액펌프',
    unit_count: 3,
    utilization: 0.2,
    peak_hour: 10,
    peak_utilization: 0.3,
    checkout_count: 12,
    verdict: 'adequate',
    additional_units: null,
    units: [],
    ...overrides,
  };
}

describe('formatPercent', () => {
  it('floors to an integer percent', () => {
    expect(formatPercent(0.396)).toBe('39%');
    expect(formatPercent(0.4)).toBe('40%');
  });

  it('does not lose a percent to floating point error', () => {
    expect(formatPercent(0.29)).toBe('29%');
    expect(formatPercent(0.57)).toBe('57%');
  });

  it('formats zero and full', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
  });
});

describe('verdictLabel', () => {
  it('names every verdict', () => {
    expect(verdictLabel('shortage')).toBe('추가 구매 검토');
    expect(verdictLabel('essential')).toBe('필수 비치');
    expect(verdictLabel('idle')).toBe('유휴');
    expect(verdictLabel('adequate')).toBe('적정');
  });
});

describe('recommendation', () => {
  it('suggests extra units for shortage', () => {
    const item = typeItem({ verdict: 'shortage', peak_hour: 14, peak_utilization: 0.92, additional_units: 1 });

    expect(recommendation(item)).toBe('14시대 가동률 92% — 1대 추가 검토');
  });

  it('suggests relocation for idle', () => {
    const item = typeItem({ verdict: 'idle', peak_hour: 9, peak_utilization: 0.18 });

    expect(recommendation(item)).toBe('가장 바쁜 9시대에도 18% — 재배치 검토');
  });

  it('says there was no checkout for idle without usage', () => {
    const item = typeItem({ verdict: 'idle', peak_hour: null, peak_utilization: 0 });

    expect(recommendation(item)).toBe('기간 중 대여 없음 — 재배치 검토');
  });

  it('keeps essential equipment in place', () => {
    expect(recommendation(typeItem({ verdict: 'essential' }))).toBe('사용 빈도와 무관하게 비치 유지');
  });

  it('has no sentence for adequate', () => {
    expect(recommendation(typeItem({ verdict: 'adequate' }))).toBeNull();
  });
});
