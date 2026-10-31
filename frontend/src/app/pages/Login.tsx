import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import AuthSplitLayout from '../components/layout/AuthSplitLayout';
import GoogleButton from '../components/GoogleButton';
import { getHomePath, getRedirectTarget, storeAuthSession, withRedirectQuery } from '../lib/auth';
import { API_BASE_URL, isGoogleLoginEnabled } from '../lib/runtime';

const ROLE_OPTIONS = [
  { value: 'staff', label: '의료진' },
  { value: 'admin', label: '관리자' },
] as const;
type LoginRole = (typeof ROLE_OPTIONS)[number]['value'];

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<LoginRole>('staff');
  const [error, setError] = useState(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return params.get('oauth_error') ? 'Google 로그인에 실패했습니다. 다시 시도해 주세요.' : '';
  });
  const [unverifiedEmail, setUnverifiedEmail] = useState('');
  const [resendMsg, setResendMsg] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTarget = getRedirectTarget(location.search);

  // Google 로그인 실패 시 백엔드가 /#oauth_error=... 로 되돌려 보낸다.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (params.get('oauth_error')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setUnverifiedEmail('');
    setResendMsg('');
    setIsLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: email.trim(),
          password,
          role,
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        const detail = payload?.detail;
        // 이메일 미인증 계정: detail 은 {code, message, email} 형태의 객체다.
        if (detail && typeof detail === 'object' && detail.code === 'email_unverified') {
          setUnverifiedEmail(detail.email ?? email.trim());
          setError(detail.message ?? '이메일 인증이 필요합니다.');
          return;
        }
        throw new Error(typeof detail === 'string' ? detail : '로그인에 실패했습니다.');
      }
      if (!payload.user || typeof payload.token !== 'string' || payload.token.length === 0) {
        throw new Error('로그인 응답이 올바르지 않습니다.');
      }

      storeAuthSession({
        token: payload.token,
        expires_at: Number(payload.expires_at ?? 0),
        user: payload.user,
      });
      navigate(redirectTarget ?? getHomePath(payload.user), { replace: true });
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('로그인 처리 중 오류가 발생했습니다.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // 가입 없이 둘러보는 공개 데모 세션. 자격증명 없이 권한만 보내면 백엔드가 데모 계정으로 발급한다.
  const handleDemoLogin = async (demoRole: LoginRole) => {
    setError('');
    setUnverifiedEmail('');
    setResendMsg('');
    setIsLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/auth/demo-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: demoRole }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload.user || typeof payload.token !== 'string') {
        const detail = payload?.detail;
        throw new Error(typeof detail === 'string' ? detail : '데모 체험을 시작하지 못했습니다.');
      }

      storeAuthSession({
        token: payload.token,
        expires_at: Number(payload.expires_at ?? 0),
        user: payload.user,
      });
      navigate(redirectTarget ?? getHomePath(payload.user), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '데모 체험 처리 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendVerification = async () => {
    setResendMsg('');
    try {
      const res = await fetch(`${API_BASE_URL}/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: unverifiedEmail }),
      });
      const payload = await res.json().catch(() => null);
      setResendMsg(payload?.message ?? '인증 메일을 다시 보냈습니다. 메일함을 확인해 주세요.');
    } catch {
      setResendMsg('인증 메일 재발송 중 오류가 발생했습니다.');
    }
  };

  const handleSignUp = () => {
    navigate(withRedirectQuery('/signup', redirectTarget));
  };

  // 어떤 출입증으로 들어갈지 먼저 고른다 — 카드 맨 위 탭.
  // 선택지가 둘뿐이라 드롭다운 대신 한눈에 보이는 라디오로 둔다.
  const badgeTabs = (
    <div className="auth-split__badge-tabs" role="radiogroup" aria-label="로그인 권한">
      {ROLE_OPTIONS.map((item) => (
        <label key={item.value}>
          <input
            type="radio"
            name="login-role"
            value={item.value}
            checked={role === item.value}
            onChange={() => setRole(item.value)}
            className="sr-only"
          />
          <span>{item.label}</span>
        </label>
      ))}
    </div>
  );

  return (
    <AuthSplitLayout title="Login" beforeTitle={badgeTabs}>
      <form onSubmit={handleLogin} className="space-y-5">
        {/* 입력칸 안에 항목 이름을 두고, 라벨은 화면 낭독기용으로만 남긴다. */}
        <div className="space-y-2">
          <Label htmlFor="email" className="sr-only">
            아이디
          </Label>
          <Input
            id="email"
            type="text"
            placeholder="Username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password" className="sr-only">
            비밀번호
          </Label>
          <Input
            id="password"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {error ? (
          <div className="alert alert-error">
            {error}
            {unverifiedEmail ? (
              <button
                type="button"
                onClick={handleResendVerification}
                className="mt-2 block font-medium underline underline-offset-2"
              >
                인증 메일 다시 보내기
              </button>
            ) : null}
          </div>
        ) : null}
        {resendMsg ? <div className="alert alert-success">{resendMsg}</div> : null}

        <Button type="submit" className="w-full" size="lg" disabled={isLoading}>
          {isLoading ? 'Logging in...' : 'Login'}
        </Button>

        <div className="auth-split__links">
          <button type="button" className="auth-split__link" onClick={handleSignUp}>
            회원가입
          </button>
          <div className="flex items-center gap-2">
            <button type="button" className="auth-split__link" onClick={() => navigate('/find-id')}>
              아이디 찾기
            </button>
            <span aria-hidden>·</span>
            <button type="button" className="auth-split__link" onClick={() => navigate('/forgot-password')}>
              비밀번호 찾기
            </button>
          </div>
        </div>

        {isGoogleLoginEnabled() ? (
          <>
            <div className="auth-split__divider">
              <span>또는</span>
            </div>

            <GoogleButton mode="login" />
          </>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => handleDemoLogin('staff')}
            disabled={isLoading}
          >
            의료진 데모
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => handleDemoLogin('admin')}
            disabled={isLoading}
          >
            관리자 데모
          </Button>
        </div>
      </form>
    </AuthSplitLayout>
  );
}
