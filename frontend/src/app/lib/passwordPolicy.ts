// 비밀번호 정책 — 백엔드 validate_password(auth_utils.py)와 1:1로 맞춘다.
// 규칙: 8자 이상, 영문/숫자/특수문자 각 1자 이상.

export type PasswordRule = {
  id: string;
  label: string;
  test: (value: string) => boolean;
};

export const PASSWORD_RULES: PasswordRule[] = [
  { id: 'length', label: '8자 이상', test: (v) => v.length >= 8 },
  { id: 'letter', label: '영문자 포함', test: (v) => /[A-Za-z]/.test(v) },
  { id: 'digit', label: '숫자 포함', test: (v) => /[0-9]/.test(v) },
  { id: 'special', label: '특수문자 포함', test: (v) => /[^A-Za-z0-9]/.test(v) },
];

// 정책 위반 시 첫 번째 실패 사유 메시지를 반환한다(없으면 null).
export function getPasswordError(value: string): string | null {
  if (value.length > 128) return '비밀번호는 128자를 초과할 수 없습니다.';
  const failed = PASSWORD_RULES.find((rule) => !rule.test(value));
  if (!failed) return null;
  return '비밀번호는 8자 이상이며 영문·숫자·특수문자를 모두 포함해야 합니다.';
}
