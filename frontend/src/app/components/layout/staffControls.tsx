import { type ReactNode } from 'react';

// 의료진 화면의 알약 전환 — 옅은 회색 트랙에서 고른 칸만 흰 면 + 청록 점
export function PillToggle<T extends string>({
  label,
  value,
  options,
  onChange,
  small,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (value: T) => void;
  small?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={small ? 'staff-seg staff-seg--small' : 'staff-seg'}
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={option.disabled}
          title={option.title}
          aria-pressed={value === option.value}
          className={value === option.value ? 'staff-seg__item staff-seg__item--on' : 'staff-seg__item'}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// 켜고 끄는 스위치 — 체크박스를 감춰 두고 트랙·손잡이를 그린다(이름은 글자가 붙는다)
export function ToggleSwitch({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="staff-switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="staff-switch__track" aria-hidden="true">
        <span className="staff-switch__knob" />
      </span>
      <span>{children}</span>
    </label>
  );
}
