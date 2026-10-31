import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import AuthSplitLayout from '../components/layout/AuthSplitLayout';
import PasswordChecklist from '../components/PasswordChecklist';
import { getPasswordError } from '../lib/passwordPolicy';
import { API_BASE_URL } from '../lib/runtime';
import { LOGIN_PATH } from '../lib/auth';

export default function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get('token') ?? '', [searchParams]);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!token) {
      setError('유효하지 않은 재설정 링크입니다.');
      return;
    }
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
      const res = await fetch(`${API_BASE_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.detail ?? '비밀번호 재설정에 실패했습니다.');
      }
      setSuccess(payload.message ?? '비밀번호가 변경되었습니다. 로그인 페이지로 이동합니다.');
      setTimeout(() => navigate(LOGIN_PATH, { replace: true }), 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 처리 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthSplitLayout title="Reset password" subtitle="새 비밀번호를 입력해 주세요.">
      {!token ? (
        <div className="alert alert-error">유효하지 않은 재설정 링크입니다. 메일의 링크를 다시 확인해 주세요.</div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="password">새 비밀번호</Label>
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
            <Label htmlFor="passwordConfirm">새 비밀번호 확인</Label>
            <Input
              id="passwordConfirm"
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              placeholder="비밀번호 다시 입력"
              required
            />
          </div>

          {error ? <div className="alert alert-error">{error}</div> : null}
          {success ? <div className="alert alert-success">{success}</div> : null}

          <Button type="submit" className="w-full" size="lg" disabled={isLoading}>
            {isLoading ? 'Updating...' : 'Change password'}
          </Button>
        </form>
      )}
    </AuthSplitLayout>
  );
}
