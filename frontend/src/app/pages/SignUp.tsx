import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import AuthSplitLayout from '../components/layout/AuthSplitLayout';
import { cn } from '../components/ui/utils';
import GoogleButton from '../components/GoogleButton';
import PasswordChecklist from '../components/PasswordChecklist';
import PasswordMatchHint from '../components/PasswordMatchHint';
import { getPasswordError } from '../lib/passwordPolicy';
import { getRedirectTarget, withRedirectQuery, LOGIN_PATH } from '../lib/auth';
import { API_BASE_URL } from '../lib/runtime';

const POSITION_OPTIONS = ['간호사', '의사', '간호조무사', '방사선사', '임상병리사', '물리치료사', '기타'];
const ROLE_OPTIONS = [
  { value: 'staff', label: '의료진' },
  { value: 'admin', label: '관리자' },
] as const;
type SignUpRole = (typeof ROLE_OPTIONS)[number]['value'];
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,49}$/;

export default function SignUp() {
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTarget = getRedirectTarget(location.search);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [department, setDepartment] = useState('');
  const [position, setPosition] = useState('간호사');
  const [role, setRole] = useState<SignUpRole>('staff');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const isAdminRole = role === 'admin';

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== passwordConfirm) {
      setError('비밀번호 확인이 일치하지 않습니다.');
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
    const policyError = getPasswordError(password);
    if (policyError) {
      setError(policyError);
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          display_name: displayName.trim(),
          password,
          email: email.trim(),
          department: isAdminRole ? null : department.trim() || null,
          position: isAdminRole ? null : position,
          role,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        const detail = payload?.detail;
        throw new Error(typeof detail === 'string' ? detail : '회원가입에 실패했습니다.');
      }

      setSuccess(
        '가입이 접수되었습니다. 입력하신 이메일로 보낸 인증 링크를 확인해 주세요. 인증 후 로그인할 수 있습니다.',
      );
      setTimeout(() => navigate(withRedirectQuery(LOGIN_PATH, redirectTarget), { replace: true }), 2500);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('회원가입 처리 중 오류가 발생했습니다.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthSplitLayout title="Sign up" subtitle="병원 계정을 만들고 장비 이력 관리를 시작하세요.">
      <form onSubmit={handleSignUp} className="space-y-5">
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
          <Label htmlFor="email">이메일</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            required
          />
        </div>

        <div className="space-y-2">
          <Label>가입 권한</Label>
          {/* 로그인 화면의 권한 선택과 같은 세그먼트 모양 — 라벨은 박스 안 중앙에 둔다. */}
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="가입 권한 선택">
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
                    'flex h-12 items-center justify-center rounded-md border text-[0.98rem] tracking-[-0.01em] transition-[border-color,box-shadow,background-color,color]',
                    'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 outline-none',
                    selected
                      ? 'border-primary bg-secondary font-medium text-foreground'
                      : 'border-input bg-input-background text-muted-foreground',
                  )}
                >
                  {item.label}
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
        {success ? <div className="alert alert-success">{success}</div> : null}

        <Button type="submit" className="w-full" size="lg" disabled={isLoading}>
          {isLoading ? 'Creating account...' : 'Create account'}
        </Button>

        <div className="auth-split__links">
          <button
            type="button"
            className="auth-split__link"
            onClick={() => navigate(withRedirectQuery(LOGIN_PATH, redirectTarget))}
          >
            로그인으로 돌아가기
          </button>
        </div>

        <div className="auth-split__divider">
          <span>또는</span>
        </div>

        <GoogleButton mode="signup" label="Google로 가입하기" />
      </form>
    </AuthSplitLayout>
  );
}
