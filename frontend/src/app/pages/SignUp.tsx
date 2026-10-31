import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import AuthSplitLayout from '../components/layout/AuthSplitLayout';
import GoogleButton from '../components/GoogleButton';
import { getRedirectTarget, withRedirectQuery, LOGIN_PATH } from '../lib/auth';
import { API_BASE_URL, isGoogleLoginEnabled } from '../lib/runtime';

const EMPLOYEE_NO_PATTERN = /^[0-9]{8}$/;

// 가입은 요청만 남긴다. 관리자가 승인하면 계정이 생기고 비밀번호 설정 메일이 간다.
export default function SignUp() {
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTarget = getRedirectTarget(location.search);
  const [employeeNo, setEmployeeNo] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  // 요청을 보냈으면 폼 대신 접수 안내를 보인다.
  const [isSent, setIsSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const goToLogin = () => navigate(withRedirectQuery(LOGIN_PATH, redirectTarget));

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!EMPLOYEE_NO_PATTERN.test(employeeNo.trim())) {
      setError('사번은 숫자 8자리여야 합니다.');
      return;
    }
    if (displayName.trim().length === 0) {
      setError('이름을 입력하세요.');
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/signup-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_no: employeeNo.trim(),
          display_name: displayName.trim(),
          email: email.trim(),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        const detail = payload?.detail;
        throw new Error(typeof detail === 'string' ? detail : '가입 요청에 실패했습니다.');
      }

      setIsSent(true);
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('가입 요청 처리 중 오류가 발생했습니다.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (isSent) {
    return (
      <AuthSplitLayout title="Request sent">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            goToLogin();
          }}
          className="space-y-5"
        >
          <div className="alert alert-success" role="status">
            가입 요청이 접수되었습니다.
          </div>
          <Button type="submit" className="w-full" size="lg">
            Go to login
          </Button>
        </form>
      </AuthSplitLayout>
    );
  }

  // 로그인 카드와 같은 크기가 되도록 로그인처럼 칸 안 글자만 보이고 라벨은 화면 낭독기용으로 둔다.
  return (
    <AuthSplitLayout title="Sign up" subtitle="관리자 승인 후 이메일로 비밀번호 설정 링크를 보내드립니다.">
      <form onSubmit={handleRequest} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="employeeNo" className="sr-only">
            사번
          </Label>
          <Input
            id="employeeNo"
            type="text"
            inputMode="numeric"
            value={employeeNo}
            onChange={(e) => setEmployeeNo(e.target.value)}
            placeholder="Employee ID"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="displayName" className="sr-only">
            이름
          </Label>
          <Input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Name"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email" className="sr-only">
            이메일
          </Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            required
          />
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}

        <Button type="submit" className="w-full" size="lg" disabled={isLoading}>
          {isLoading ? 'Sending request...' : 'Send request'}
        </Button>

        <div className="auth-split__links">
          <button type="button" className="auth-split__link" onClick={goToLogin}>
            로그인으로 돌아가기
          </button>
        </div>

        {isGoogleLoginEnabled() ? (
          <>
            <div className="auth-split__divider">
              <span>또는</span>
            </div>

            <GoogleButton mode="signup" label="Google로 가입하기" />
          </>
        ) : null}
      </form>
    </AuthSplitLayout>
  );
}
