import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import AuthSplitLayout from '../components/layout/AuthSplitLayout';
import { API_BASE_URL } from '../lib/runtime';
import { LOGIN_PATH } from '../lib/auth';

export default function FindId() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/find-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.detail ?? '요청 처리에 실패했습니다.');
      }
      setMessage(payload.message ?? '가입된 계정이 있다면 아이디를 메일로 보냈습니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '요청 처리 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthSplitLayout title="Find ID" subtitle="가입 시 등록한 이메일을 입력하세요.">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email">이메일</Label>
          <Input
            id="email"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        {error ? <div className="alert alert-error">{error}</div> : null}
        {message ? <div className="alert alert-success">{message}</div> : null}

        <Button type="submit" className="w-full" size="lg" disabled={isLoading}>
          {isLoading ? 'Sending...' : 'Find ID'}
        </Button>

        <div className="auth-split__links">
          <button type="button" className="auth-split__link" onClick={() => navigate(LOGIN_PATH)}>
            로그인으로 돌아가기
          </button>
        </div>
      </form>
    </AuthSplitLayout>
  );
}
