import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import AuthSplitLayout from '../components/layout/AuthSplitLayout';
import { cn } from '../components/ui/utils';
import PasswordChecklist from '../components/PasswordChecklist';
import PasswordMatchHint from '../components/PasswordMatchHint';
import { getPasswordError } from '../lib/passwordPolicy';
import { storeAuthSession } from '../lib/auth';
import { API_BASE_URL } from '../lib/runtime';

const POSITION_OPTIONS = ['간호사', '의사', '간호조무사', '방사선사', '임상병리사', '물리치료사', '기타'];
const ROLE_OPTIONS = [
  { value: 'staff', label: '의료진' },
  { value: 'admin', label: '관리자' },
] as const;
type Role = (typeof ROLE_OPTIONS)[number]['value'];
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,49}$/;

// Google 인증만으로는 가입이 완료되지 않으므로(부서/직책 등 추가 정보 필요)
// 백엔드가 넘겨준 pending 토큰과 함께 부족한 정보를 받아 가입을 마무리한다.
export default function SignUpComplete() {
  const navigate = useNavigate();
  const { pending, googleEmail, googleName } = useMemo(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return {
      pending: params.get('pending') ?? '',
      googleEmail: params.get('email') ?? '',
      googleName: params.get('name') ?? '',
    };
  }, []);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState(googleName);
  const [department, setDepartment] = useState('');
  const [position, setPosition] = useState('간호사');
  const [role, setRole] = useState<Role>('staff');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const isAdminRole = role === 'admin';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!pending) {
      setError('가입 요청 정보가 없습니다. 처음부터 다시 시도해 주세요.');
      return;
    }
    if (!USERNAME_PATTERN.test(username.trim())) {
      setError("아이디는 3~50자의 영문, 숫자, '.', '_', '-'만 사용할 수 있습니다.");
      return;
    }
    if (displayName.trim().length === 0) {
      setError('이름을 입력하세요.');
      return;
    }
    // Google 첫 가입도 비밀번호를 필수로 설정한다(아이디/비밀번호 로그인도 가능하도록).
    const policyError = getPasswordError(password);
    if (policyError) {
      setError(policyError);
      return;
    }
    if (password !== passwordConfirm) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/google/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pending_token: pending,
          username: username.trim(),
          display_name: displayName.trim(),
          role,
          department: isAdminRole ? null : department.trim() || null,
          position: isAdminRole ? null : position,
          password: password || null,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok || !payload.token || !payload.user) {
        throw new Error(payload?.detail ?? '가입에 실패했습니다.');
      }
      storeAuthSession({
        token: payload.token,
        expires_at: Number(payload.expires_at ?? 0),
        user: payload.user,
      });
      const loginRole = (payload.user?.role as string | undefined)?.toLowerCase();
      navigate(loginRole === 'admin' ? '/verification' : '/equipment', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '가입 처리 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthSplitLayout
      title="Complete sign-up"
      subtitle="Google 계정 인증이 확인되었습니다. 가입을 완료하려면 아래 정보를 입력해 주세요."
    >
      {!pending ? (
        <div className="alert alert-error">가입 요청 정보가 없습니다. 로그인 화면에서 다시 시도해 주세요.</div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="google-email">이메일 (Google)</Label>
            <Input id="google-email" type="email" value={googleEmail} readOnly disabled />
          </div>

          <div className="space-y-2">
            <Label htmlFor="username">아이디</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="test"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="displayName">이름</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="홍길동"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>가입 권한</Label>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="가입 권한 선택">
              {ROLE_OPTIONS.map((item) => {
                const selected = role === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setRole(item.value)}
                    className={cn(
                      'border px-4 py-4 text-left transition-all duration-200',
                      selected ? 'border-foreground bg-secondary' : 'border-border bg-card hover:-translate-y-0.5',
                    )}
                  >
                    <div className="text-base font-semibold text-foreground">{item.label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {!isAdminRole ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="department">부서</Label>
                <Input
                  id="department"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  placeholder="내과"
                />
              </div>

              <div className="space-y-2">
                <Label>직책</Label>
                <Select value={position} onValueChange={setPosition}>
                  <SelectTrigger>
                    <SelectValue placeholder="직책 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {POSITION_OPTIONS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="password">비밀번호</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="영문·숫자·특수문자 포함 8자 이상"
              required
            />
            <PasswordChecklist value={password} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="passwordConfirm">비밀번호 확인</Label>
            <Input
              id="passwordConfirm"
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              placeholder="비밀번호 다시 입력"
              required
            />
            <PasswordMatchHint password={password} confirm={passwordConfirm} />
          </div>

          {error ? <div className="alert alert-error">{error}</div> : null}

          <Button type="submit" className="w-full" size="lg" disabled={isLoading}>
            {isLoading ? 'Creating account...' : 'Create account'}
          </Button>
        </form>
      )}
    </AuthSplitLayout>
  );
}
