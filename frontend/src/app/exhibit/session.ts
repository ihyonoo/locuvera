// 무인 전시 화면은 공개 데모 계정으로만 돈다
// 데모 계정은 가입 승인·NFC 매핑·계정 변경이 막혀 있다(백엔드 403)
import { getStoredAuthSession, storeAuthSession } from '../lib/auth';
import { API_BASE_URL } from '../lib/runtime';
import type { DemoRole } from './player';

// 이보다 짧게 남은 세션은 장면 도중 끊기지 않게 미리 새로 받는다
const RENEW_BEFORE_SEC = 600;

export async function ensureDemoSession(role: DemoRole, fetchImpl: typeof fetch = fetch): Promise<void> {
  const session = getStoredAuthSession();
  const nowSec = Math.floor(Date.now() / 1000);
  if (session?.user.is_demo && session.user.role === role && session.expires_at - nowSec > RENEW_BEFORE_SEC) {
    return;
  }

  const response = await fetchImpl(`${API_BASE_URL}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || !payload.user || typeof payload.token !== 'string') {
    throw new Error('데모 로그인 실패');
  }
  storeAuthSession({ token: payload.token, expires_at: Number(payload.expires_at ?? 0), user: payload.user });
}
