// 배터리 잔량 아이콘. 몸통 안 막대가 잔량(%)만큼 차고, 잔량에 따라 초록·주황·빨강으로 칠한다
// 옆 글자가 %를 말하므로 화면 낭독기에서는 숨긴다
const LEVEL_MAX_WIDTH = 14;
// 이 잔량(%) 미만은 주황. 빨강(low)은 교체 기준을 정하는 호출부가 넘긴다
const MID_PCT = 50;

type BatteryIconProps = {
  pct: number;
  low: boolean;
};

export default function BatteryIcon({ pct, low }: BatteryIconProps) {
  const level = (LEVEL_MAX_WIDTH * Math.min(Math.max(pct, 0), 100)) / 100;
  const tone = low ? 'low' : pct < MID_PCT ? 'mid' : 'high';

  return (
    <svg aria-hidden="true" viewBox="0 0 21 10" width="21" height="10" className="staff-battery">
      <rect x="0.5" y="0.5" width="17" height="9" rx="2" fill="none" stroke="currentColor" />
      <rect x="18" y="3" width="2.5" height="4" rx="0.75" fill="currentColor" />
      <rect data-part="level" className={`staff-battery__level--${tone}`} x="2" y="2" width={level} height="6" rx="1" />
    </svg>
  );
}
