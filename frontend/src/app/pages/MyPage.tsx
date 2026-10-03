import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import AppShell from '../components/layout/AppShell';
import AdminNav from '../components/layout/AdminNav';
import StaffNav from '../components/layout/StaffNav';
import PasswordChecklist from '../components/PasswordChecklist';
import PasswordMatchHint from '../components/PasswordMatchHint';
import { getPasswordError } from '../lib/passwordPolicy';
import {
  buildAuthHeaders,
  clearStoredAuthSession,
  getStoredAuthSession,
  getStoredAuthToken,
  LOGIN_PATH,
  storeAuthSession,
  type AuthUser,
} from '../lib/auth';
import { API_BASE_URL } from '../lib/runtime';

type MeUser = AuthUser & { created_at?: string | null; google_linked?: boolean };

type UsageHistoryItem = {
  usage_id: number;
  usage_status: string;
  equipment: { name: string | null; type: string | null };
  checkout: { location: string | null; at: number | null };
  return: { location: string | null; at: number | null };
  movement_path: Array<{ location: string; at: number }>;
};

const ROLE_LABEL: Record<string, string> = { admin: '관리자', staff: '의료진' };

const DEMO_NOTICE = '데모 체험 계정에서는 계정 설정을 변경할 수 없습니다.';

type AccountAction = 'password' | 'email' | 'google' | 'withdraw';

function formatDateTime(epoch: number | null | undefined) {
  if (!epoch) return '-';
  return new Date(epoch * 1000).toLocaleString('ko-KR', { hour12: false });
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('ko-KR');
}

export default function MyPage() {
  const navigate = useNavigate();
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [history, setHistory] = useState<UsageHistoryItem[]>([]);

  const isStaff = (user?.role ?? '').toLowerCase() === 'staff';

  // 데모 계정은 계정 설정을 바꿀 수 없다(백엔드도 403). 클릭한 섹션에 안내만 띄운다.
  const [demoBlocked, setDemoBlocked] = useState<AccountAction | null>(null);

  const blockedForDemo = (action: AccountAction) => {
    if (user?.is_demo !== true) return false;
    setDemoBlocked(action);
    return true;
  };

  const logout = () => {
    clearStoredAuthSession();
    navigate(LOGIN_PATH, { replace: true });
  };

  // 인증 헤더를 붙여 요청하고, 401이면 세션을 정리한다.
  const authFetch = async (path: string, init?: RequestInit) => {
    const token = getStoredAuthToken();
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: buildAuthHeaders(token, {
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      }),
    });
    if (res.status === 401) {
      logout();
      throw new Error('세션이 만료되었습니다. 다시 로그인해 주세요.');
    }
    return res;
  };

  const loadMe = async () => {
    const res = await authFetch('/auth/me');
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.ok || !payload.user) {
      throw new Error(payload?.detail ?? '내 정보를 불러오지 못했습니다.');
    }
    setUser(payload.user as MeUser);
    return payload.user as MeUser;
  };

  useEffect(() => {
    const session = getStoredAuthSession();
    if (!session) {
      navigate(LOGIN_PATH, { replace: true });
      return;
    }
    (async () => {
      try {
        const me = await loadMe();
        if ((me.role ?? '').toLowerCase() === 'staff') {
          const res = await authFetch('/usage/me/history?limit=100');
          const payload = await res.json().catch(() => null);
          if (res.ok && payload?.ok) {
            setHistory(payload.items ?? []);
          }
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : '내 정보를 불러오지 못했습니다.');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 비밀번호 변경 ---
  const [pwOpen, setPwOpen] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPwConfirm, setNewPwConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  const resetPasswordForm = () => {
    setCurrentPw('');
    setNewPw('');
    setNewPwConfirm('');
    setPwMsg(null);
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    const policyError = getPasswordError(newPw);
    if (policyError) {
      setPwMsg({ tone: 'err', text: policyError });
      return;
    }
    if (newPw !== newPwConfirm) {
      setPwMsg({ tone: 'err', text: '비밀번호 확인이 일치하지 않습니다.' });
      return;
    }
    setPwBusy(true);
    try {
      const res = await authFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok || !payload.token || !payload.user) {
        throw new Error(payload?.detail ?? '비밀번호 변경에 실패했습니다.');
      }
      // token_version 이 올라가 기존 토큰은 무효화되므로 새 세션으로 갱신한다.
      storeAuthSession({
        token: payload.token,
        expires_at: Number(payload.expires_at ?? 0),
        user: payload.user,
      });
      setCurrentPw('');
      setNewPw('');
      setNewPwConfirm('');
      setPwMsg({ tone: 'ok', text: '비밀번호가 변경되었습니다.' });
    } catch (err) {
      setPwMsg({ tone: 'err', text: err instanceof Error ? err.message : '비밀번호 변경에 실패했습니다.' });
    } finally {
      setPwBusy(false);
    }
  };

  // --- 이메일 변경 ---
  const [emailOpen, setEmailOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailPw, setEmailPw] = useState('');
  const [emailMsg, setEmailMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);

  const resetEmailForm = () => {
    setNewEmail('');
    setEmailPw('');
    setEmailMsg(null);
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailMsg(null);
    setEmailBusy(true);
    try {
      const res = await authFetch('/auth/change-email', {
        method: 'POST',
        body: JSON.stringify({ new_email: newEmail.trim(), current_password: emailPw }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.detail ?? '이메일 변경에 실패했습니다.');
      }
      setUser((prev) =>
        prev ? { ...prev, email: payload.user?.email ?? newEmail.trim(), email_verified: false } : prev,
      );
      setNewEmail('');
      setEmailPw('');
      setEmailMsg({ tone: 'ok', text: payload.message ?? '이메일이 변경되었습니다. 인증 메일을 확인해 주세요.' });
    } catch (err) {
      setEmailMsg({ tone: 'err', text: err instanceof Error ? err.message : '이메일 변경에 실패했습니다.' });
    } finally {
      setEmailBusy(false);
    }
  };

  const resendVerification = async () => {
    if (!user?.email) return;
    setEmailMsg(null);
    try {
      const res = await fetch(`${API_BASE_URL}/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        throw new Error('인증 메일 재발송에 실패했습니다.');
      }
      setEmailMsg({ tone: 'ok', text: payload?.message ?? '인증 메일을 다시 보냈습니다.' });
    } catch {
      setEmailMsg({ tone: 'err', text: '인증 메일 재발송에 실패했습니다.' });
    }
  };

  // --- Google 연동 ---
  const [googleMsg, setGoogleMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);

  const unlinkGoogle = async () => {
    if (blockedForDemo('google')) return;
    setGoogleMsg(null);
    setGoogleBusy(true);
    try {
      const res = await authFetch('/auth/google/unlink', { method: 'POST' });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.detail ?? 'Google 연동 해제에 실패했습니다.');
      }
      setUser((prev) => (prev ? { ...prev, google_linked: false } : prev));
      setGoogleMsg({ tone: 'ok', text: payload.message ?? 'Google 연동이 해제되었습니다.' });
    } catch (err) {
      setGoogleMsg({ tone: 'err', text: err instanceof Error ? err.message : 'Google 연동 해제에 실패했습니다.' });
    } finally {
      setGoogleBusy(false);
    }
  };

  const linkGoogle = () => {
    if (blockedForDemo('google')) return;
    // 로그인 상태에서 동일 인증 이메일로 Google 로그인하면 콜백이 자동 연동한다.
    window.location.href = `${API_BASE_URL}/auth/google/start?mode=login`;
  };

  // --- 회원 탈퇴 ---
  const [withdrawPw, setWithdrawPw] = useState('');
  const [withdrawMsg, setWithdrawMsg] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const submitWithdraw = async () => {
    setWithdrawMsg('');
    setWithdrawBusy(true);
    try {
      const res = await authFetch('/auth/withdraw', {
        method: 'POST',
        body: JSON.stringify({ current_password: withdrawPw }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.detail ?? '회원 탈퇴에 실패했습니다.');
      }
      clearStoredAuthSession();
      navigate(LOGIN_PATH, { replace: true });
    } catch (err) {
      setWithdrawMsg(err instanceof Error ? err.message : '회원 탈퇴에 실패했습니다.');
    } finally {
      setWithdrawBusy(false);
    }
  };

  // 세션에 저장된 역할을 즉시 참조해, /auth/me 응답을 기다리는 동안 네비게이션이 깜빡이지 않게 한다.
  const sessionRole = (getStoredAuthSession()?.user?.role ?? user?.role ?? '').toLowerCase();

  return (
    <AppShell
      wide
      actions={sessionRole === 'admin' ? <AdminNav active="mypage" /> : <StaffNav active="mypage" />}
      contentClassName="pt-6 sm:pt-5"
    >
      {/* 다른 관리 화면과 같은 본문 폭 */}
      <div className="mx-auto w-full max-w-[1360px] space-y-4">
        {loading ? (
          <div className="alert">불러오는 중입니다...</div>
        ) : loadError ? (
          <div className="alert alert-error">{loadError}</div>
        ) : user ? (
          <>
            {/* 내 정보 */}
            <section className="surface-panel p-6 fade-rise">
              <div className="panel-title mb-4">내 정보</div>
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-4">
                <InfoField label="아이디" value={user.username} />
                <InfoField label="이름" value={user.display_name} />
                <div className="space-y-1">
                  <dt className="text-xs text-muted-foreground">이메일</dt>
                  <dd className="flex items-center gap-2 text-sm">
                    <span>{user.email ?? '-'}</span>
                    {user.email ? (
                      <span
                        className={`inline-flex items-center border px-2 py-0.5 text-xs ${
                          user.email_verified ? 'tone-ok' : 'tone-warn'
                        }`}
                      >
                        {user.email_verified ? '인증됨' : '미인증'}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <InfoField label="권한" value={ROLE_LABEL[(user.role ?? '').toLowerCase()] ?? user.role} />
                {(user.role ?? '').toLowerCase() === 'staff' ? (
                  <>
                    <InfoField label="부서" value={user.department ?? '-'} />
                    <InfoField label="직책" value={user.position ?? '-'} />
                  </>
                ) : null}
                <InfoField label="가입일" value={formatDate(user.created_at)} />
                <InfoField label="Google 연동" value={user.google_linked ? '연동됨' : '미연동'} />
              </dl>
            </section>

            {/* 비밀번호 변경 (토글) */}
            <section className="surface-panel p-6 fade-rise">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">비밀번호 변경</div>
                  <p className="panel-copy mt-1">변경하면 다른 기기의 로그인은 자동으로 해제됩니다.</p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (blockedForDemo('password')) return;
                    setPwOpen((open) => {
                      if (open) resetPasswordForm();
                      return !open;
                    });
                  }}
                >
                  {pwOpen ? '닫기' : '변경'}
                </Button>
              </div>
              {demoBlocked === 'password' ? <div className="alert alert-error mt-4">{DEMO_NOTICE}</div> : null}
              {/* 패널은 넓어져도 입력 줄은 읽기 좋은 폭(max-w-2xl)으로 묶어 둔다 */}
              {pwOpen ? (
                <form onSubmit={submitPassword} className="mt-4 max-w-2xl space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="current-pw">현재 비밀번호</Label>
                    <Input
                      id="current-pw"
                      type="password"
                      value={currentPw}
                      onChange={(e) => setCurrentPw(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-pw">새 비밀번호</Label>
                    <Input
                      id="new-pw"
                      type="password"
                      value={newPw}
                      onChange={(e) => setNewPw(e.target.value)}
                      placeholder="영문·숫자·특수문자 포함 8자 이상"
                      required
                    />
                    <PasswordChecklist value={newPw} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-pw-confirm">새 비밀번호 확인</Label>
                    <Input
                      id="new-pw-confirm"
                      type="password"
                      value={newPwConfirm}
                      onChange={(e) => setNewPwConfirm(e.target.value)}
                      placeholder="새 비밀번호 다시 입력"
                      required
                    />
                    <PasswordMatchHint password={newPw} confirm={newPwConfirm} />
                  </div>
                  {pwMsg ? (
                    <div className={pwMsg.tone === 'ok' ? 'alert alert-success' : 'alert alert-error'}>
                      {pwMsg.text}
                    </div>
                  ) : null}
                  <Button type="submit" disabled={pwBusy}>
                    {pwBusy ? '변경 중...' : '비밀번호 변경'}
                  </Button>
                </form>
              ) : null}
            </section>

            {/* 이메일 변경 (토글) */}
            <section className="surface-panel p-6 fade-rise">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">이메일 변경</div>
                  <p className="panel-copy mt-1">
                    변경 후 새 이메일로 인증 링크가 발송됩니다. 재인증 전까지는 재로그인이 제한될 수 있습니다.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (blockedForDemo('email')) return;
                    setEmailOpen((open) => {
                      if (open) resetEmailForm();
                      return !open;
                    });
                  }}
                >
                  {emailOpen ? '닫기' : '변경'}
                </Button>
              </div>
              {demoBlocked === 'email' ? <div className="alert alert-error mt-4">{DEMO_NOTICE}</div> : null}
              {emailOpen ? (
                <form onSubmit={submitEmail} className="mt-4 max-w-2xl space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="new-email">새 이메일</Label>
                    <Input
                      id="new-email"
                      type="email"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      placeholder="new@example.com"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email-pw">현재 비밀번호</Label>
                    <Input
                      id="email-pw"
                      type="password"
                      value={emailPw}
                      onChange={(e) => setEmailPw(e.target.value)}
                      required
                    />
                  </div>
                  {emailMsg ? (
                    <div className={emailMsg.tone === 'ok' ? 'alert alert-success' : 'alert alert-error'}>
                      {emailMsg.text}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={emailBusy}>
                      {emailBusy ? '변경 중...' : '이메일 변경'}
                    </Button>
                    {user.email && !user.email_verified ? (
                      <Button type="button" variant="outline" onClick={resendVerification}>
                        인증 메일 재발송
                      </Button>
                    ) : null}
                  </div>
                </form>
              ) : null}
            </section>

            {/* Google 연동 */}
            <section className="surface-panel p-6 fade-rise">
              <div className="panel-title mb-1">Google 연동</div>
              <p className="panel-copy mb-4">
                {user.google_linked
                  ? '이 계정은 Google 로그인과 연동되어 있습니다.'
                  : '동일한 인증 이메일로 Google 로그인하면 이 계정에 자동으로 연동됩니다.'}
              </p>
              {googleMsg ? (
                <div className={`mb-4 ${googleMsg.tone === 'ok' ? 'alert alert-success' : 'alert alert-error'}`}>
                  {googleMsg.text}
                </div>
              ) : null}
              {demoBlocked === 'google' ? <div className="alert alert-error mb-4">{DEMO_NOTICE}</div> : null}
              {user.google_linked ? (
                <Button variant="outline" onClick={unlinkGoogle} disabled={googleBusy}>
                  {googleBusy ? '해제 중...' : 'Google 연동 해제'}
                </Button>
              ) : (
                <Button variant="outline" onClick={linkGoogle}>
                  Google 계정 연동
                </Button>
              )}
            </section>

            {/* 내 사용 이력 (staff 전용) */}
            {isStaff ? (
              <section className="surface-panel p-6 fade-rise">
                <div className="panel-title mb-1">내 사용 이력</div>
                <p className="panel-copy mb-4">내가 대여/반납한 장비 기록입니다.</p>
                {history.length === 0 ? (
                  <div className="alert">사용 이력이 없습니다.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">장비</th>
                          <th className="py-2 pr-3 font-medium">대여 (위치 · 시각)</th>
                          <th className="py-2 pr-3 font-medium">반납 (위치 · 시각)</th>
                          <th className="py-2 pr-3 font-medium">이동 경로</th>
                          <th className="py-2 font-medium">상태</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((item) => (
                          <tr key={item.usage_id} className="border-b last:border-0 align-top">
                            <td className="py-2 pr-3">
                              <div className="font-medium">{item.equipment.name ?? '-'}</div>
                              {item.equipment.type ? (
                                <div className="text-xs text-muted-foreground">{item.equipment.type}</div>
                              ) : null}
                            </td>
                            <td className="py-2 pr-3">
                              <div>{item.checkout.location ?? '-'}</div>
                              <div className="text-xs text-muted-foreground">{formatDateTime(item.checkout.at)}</div>
                            </td>
                            <td className="py-2 pr-3">
                              <div>{item.return.location ?? '-'}</div>
                              <div className="text-xs text-muted-foreground">{formatDateTime(item.return.at)}</div>
                            </td>
                            <td className="py-2 pr-3">
                              {item.movement_path && item.movement_path.length > 0
                                ? item.movement_path.map((point) => point.location).join(' → ')
                                : '-'}
                            </td>
                            <td className="py-2">
                              <span
                                className={`inline-flex items-center border px-2 py-0.5 text-xs ${
                                  item.usage_status === 'returned' ? 'tone-neutral' : 'tone-ok'
                                }`}
                              >
                                {item.usage_status === 'returned' ? '반납됨' : '사용 중'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : null}

            {/* 회원 탈퇴 */}
            <section className="surface-panel p-6 fade-rise">
              <div className="panel-title mb-1 text-err">회원 탈퇴</div>
              <p className="panel-copy mb-4">탈퇴하면 계정이 비활성화되고 다시 로그인할 수 없습니다.</p>
              {demoBlocked === 'withdraw' ? <div className="alert alert-error mb-4">{DEMO_NOTICE}</div> : null}
              {!withdrawOpen ? (
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (blockedForDemo('withdraw')) return;
                    setWithdrawOpen(true);
                  }}
                >
                  회원 탈퇴
                </Button>
              ) : (
                <div className="max-w-2xl space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="withdraw-pw">현재 비밀번호 확인</Label>
                    <Input
                      id="withdraw-pw"
                      type="password"
                      value={withdrawPw}
                      onChange={(e) => setWithdrawPw(e.target.value)}
                      required
                    />
                  </div>
                  {withdrawMsg ? <div className="alert alert-error">{withdrawMsg}</div> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="destructive" onClick={submitWithdraw} disabled={withdrawBusy || !withdrawPw}>
                      {withdrawBusy ? '처리 중...' : '탈퇴 확인'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setWithdrawOpen(false);
                        setWithdrawPw('');
                        setWithdrawMsg('');
                      }}
                    >
                      취소
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

function InfoField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value ?? '-'}</dd>
    </div>
  );
}
