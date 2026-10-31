import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Input } from '../components/ui/input';
import StaffShell from '../components/layout/StaffShell';
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
import { API_BASE_URL, isGoogleLoginEnabled } from '../lib/runtime';

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

// 2026.10.31 14:02 — 사용 이력용 짧은 시각
function formatShort(epoch: number | null | undefined) {
  if (!epoch) return null;
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

  const submitPassword = async (e: FormEvent) => {
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

  const submitEmail = async (e: FormEvent) => {
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

  // 세션에 저장된 역할을 즉시 참조해, /auth/me 응답을 기다리는 동안 메뉴가 깜빡이지 않게 한다.
  const sessionRole = (getStoredAuthSession()?.user?.role ?? user?.role ?? '').toLowerCase();

  const togglePasswordForm = () => {
    if (blockedForDemo('password')) return;
    setPwOpen((open) => {
      if (open) resetPasswordForm();
      return !open;
    });
  };

  const toggleEmailForm = () => {
    if (blockedForDemo('email')) return;
    setEmailOpen((open) => {
      if (open) resetEmailForm();
      return !open;
    });
  };

  const cancelWithdraw = () => {
    setWithdrawOpen(false);
    setWithdrawPw('');
    setWithdrawMsg('');
  };

  return (
    <StaffShell menu={sessionRole === 'admin' ? 'admin' : 'staff'} current="mypage">
      <div className="staff-me">
        {loading ? (
          <div className="staff-empty">불러오는 중입니다…</div>
        ) : loadError ? (
          <div className="staff-alert">{loadError}</div>
        ) : user ? (
          <>
            {/* 프로필 머리글 — 이름 · 부서·직책 · 아이디/권한/가입일 */}
            <header className="staff-me__header">
              <h1 className="staff-me__name">{user.display_name}</h1>
              {isStaff && (user.department || user.position) ? (
                <div className="staff-profile__meta">
                  {[user.department, user.position].filter(Boolean).join(' · ')}
                </div>
              ) : null}
              <dl className="staff-facts-inline">
                <div>
                  <dt>아이디</dt>
                  <dd>{user.username}</dd>
                </div>
                <div>
                  <dt>권한</dt>
                  <dd>{ROLE_LABEL[(user.role ?? '').toLowerCase()] ?? user.role}</dd>
                </div>
                <div>
                  <dt>가입일</dt>
                  <dd>{formatDate(user.created_at)}</dd>
                </div>
                {isGoogleLoginEnabled() ? (
                  <div>
                    <dt>Google</dt>
                    <dd>{user.google_linked ? '연동됨' : '미연동'}</dd>
                  </div>
                ) : null}
              </dl>
              {user.is_demo ? <p className="staff-note">데모 체험 계정은 계정 설정을 바꿀 수 없습니다.</p> : null}
            </header>

            {/* 계정 — 줄마다 '변경'을 누르면 그 줄 아래에 입력칸이 펼쳐진다 */}
            <section className="staff-panel">
              <h2 className="staff-panel__title">계정</h2>

              <SettingRow
                label="이메일"
                value={
                  <>
                    <span>{user.email ?? '등록된 이메일 없음'}</span>
                    {user.email ? (
                      <span className="staff-status">
                        <span className={user.email_verified ? 'staff-led' : 'staff-led staff-led--warn'} />
                        {user.email_verified ? '인증됨' : '미인증'}
                      </span>
                    ) : null}
                  </>
                }
                help="변경하면 새 이메일로 인증 링크가 발송됩니다. 재인증 전까지는 재로그인이 제한될 수 있습니다."
                action={
                  <button type="button" className="staff-btn" onClick={toggleEmailForm}>
                    {emailOpen ? '닫기' : '변경'}
                  </button>
                }
              >
                {demoBlocked === 'email' ? <div className="staff-alert">{DEMO_NOTICE}</div> : null}
                {emailOpen ? (
                  <form onSubmit={submitEmail} className="staff-form">
                    <Field id="new-email" label="새 이메일">
                      <Input
                        id="new-email"
                        type="email"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        placeholder="new@example.com"
                        required
                      />
                    </Field>
                    <Field id="email-pw" label="현재 비밀번호">
                      <Input
                        id="email-pw"
                        type="password"
                        value={emailPw}
                        onChange={(e) => setEmailPw(e.target.value)}
                        required
                      />
                    </Field>
                    <Notice msg={emailMsg} />
                    <div className="staff-actions">
                      <button type="submit" className="staff-btn staff-btn--primary" disabled={emailBusy}>
                        {emailBusy ? '변경 중…' : '이메일 변경'}
                      </button>
                      {user.email && !user.email_verified ? (
                        <button type="button" className="staff-btn" onClick={resendVerification}>
                          인증 메일 다시 보내기
                        </button>
                      ) : null}
                    </div>
                  </form>
                ) : null}
              </SettingRow>

              <SettingRow
                label="비밀번호"
                help="변경하면 다른 기기의 로그인은 자동으로 해제됩니다."
                action={
                  <button type="button" className="staff-btn" onClick={togglePasswordForm}>
                    {pwOpen ? '닫기' : '변경'}
                  </button>
                }
              >
                {demoBlocked === 'password' ? <div className="staff-alert">{DEMO_NOTICE}</div> : null}
                {pwOpen ? (
                  <form onSubmit={submitPassword} className="staff-form">
                    <Field id="current-pw" label="현재 비밀번호">
                      <Input
                        id="current-pw"
                        type="password"
                        value={currentPw}
                        onChange={(e) => setCurrentPw(e.target.value)}
                        required
                      />
                    </Field>
                    <Field id="new-pw" label="새 비밀번호">
                      <Input
                        id="new-pw"
                        type="password"
                        value={newPw}
                        onChange={(e) => setNewPw(e.target.value)}
                        placeholder="영문·숫자·특수문자 포함 8자 이상"
                        required
                      />
                      <PasswordChecklist value={newPw} />
                    </Field>
                    <Field id="new-pw-confirm" label="새 비밀번호 확인">
                      <Input
                        id="new-pw-confirm"
                        type="password"
                        value={newPwConfirm}
                        onChange={(e) => setNewPwConfirm(e.target.value)}
                        placeholder="새 비밀번호 다시 입력"
                        required
                      />
                      <PasswordMatchHint password={newPw} confirm={newPwConfirm} />
                    </Field>
                    <Notice msg={pwMsg} />
                    <div className="staff-actions">
                      <button type="submit" className="staff-btn staff-btn--primary" disabled={pwBusy}>
                        {pwBusy ? '변경 중…' : '비밀번호 변경'}
                      </button>
                    </div>
                  </form>
                ) : null}
              </SettingRow>

              {/* Google 연동 — Google 로그인이 켜져 있을 때만 */}
              {isGoogleLoginEnabled() ? (
                <SettingRow
                  label="Google 연동"
                  help={
                    user.google_linked
                      ? '이 계정은 Google 로그인과 연동되어 있습니다.'
                      : '같은 인증 이메일로 Google 로그인하면 이 계정에 자동으로 연동됩니다.'
                  }
                  action={
                    user.google_linked ? (
                      <button type="button" className="staff-btn" onClick={unlinkGoogle} disabled={googleBusy}>
                        {googleBusy ? '해제 중…' : '연동 해제'}
                      </button>
                    ) : (
                      <button type="button" className="staff-btn" onClick={linkGoogle}>
                        연동
                      </button>
                    )
                  }
                >
                  {demoBlocked === 'google' ? <div className="staff-alert">{DEMO_NOTICE}</div> : null}
                  <Notice msg={googleMsg} />
                </SettingRow>
              ) : null}
            </section>

            {/* 내 사용 이력 (의료진 전용) — 장비마다 한 덩어리 */}
            {isStaff ? (
              <section className="staff-panel">
                <div className="staff-panel__head">
                  <h2 className="staff-panel__title">내 사용 이력</h2>
                  {history.length > 0 ? <span className="staff-panel__meta">{history.length}건</span> : null}
                </div>
                {history.length === 0 ? (
                  <div className="staff-empty-block">
                    <p>아직 대여하거나 반납한 장비가 없습니다.</p>
                    <button type="button" className="staff-btn" onClick={() => navigate('/equipment')}>
                      장비 찾기
                    </button>
                  </div>
                ) : (
                  <ul className="staff-history">
                    {history.map((item) => {
                      const inUse = item.usage_status !== 'returned';
                      const checkoutAt = formatShort(item.checkout.at);
                      const returnAt = formatShort(item.return.at);
                      return (
                        <li key={item.usage_id} className="staff-history__item">
                          <div className="staff-history__head">
                            <span className="staff-history__name">{item.equipment.name ?? '-'}</span>
                            <span className="staff-status">
                              <span className={inUse ? 'staff-led' : 'staff-led staff-led--off'} />
                              {inUse ? '사용 중' : '반납됨'}
                            </span>
                          </div>
                          {item.equipment.type ? (
                            <div className="staff-history__type">{item.equipment.type}</div>
                          ) : null}
                          <dl className="staff-history__grid">
                            <dt>대여</dt>
                            <dd>
                              {item.checkout.location ?? '-'}
                              {checkoutAt ? <time> · {checkoutAt}</time> : null}
                            </dd>
                            <dt>반납</dt>
                            <dd>
                              {item.return.location ?? '-'}
                              {returnAt ? <time> · {returnAt}</time> : null}
                            </dd>
                            {item.movement_path && item.movement_path.length > 0 ? (
                              <>
                                <dt>경로</dt>
                                <dd>{item.movement_path.map((point) => point.location).join(' → ')}</dd>
                              </>
                            ) : null}
                          </dl>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            ) : null}

            {/* 회원 탈퇴 — 맨 아래 조용한 글자 단추, 누르면 그 자리에서 비밀번호 확인 */}
            <div className="staff-me__danger">
              {demoBlocked === 'withdraw' ? <div className="staff-alert">{DEMO_NOTICE}</div> : null}
              {withdrawOpen ? (
                <section className="staff-panel staff-withdraw">
                  <div className="staff-withdraw__title">회원 탈퇴</div>
                  <p className="staff-setting__help">탈퇴하면 계정이 비활성화되고 다시 로그인할 수 없습니다.</p>
                  <div className="staff-form">
                    <Field id="withdraw-pw" label="현재 비밀번호 확인">
                      <Input
                        id="withdraw-pw"
                        type="password"
                        value={withdrawPw}
                        onChange={(e) => setWithdrawPw(e.target.value)}
                        required
                      />
                    </Field>
                    {withdrawMsg ? <div className="staff-alert">{withdrawMsg}</div> : null}
                    <div className="staff-actions">
                      <button
                        type="button"
                        className="staff-btn staff-btn--danger"
                        onClick={submitWithdraw}
                        disabled={withdrawBusy || !withdrawPw}
                      >
                        {withdrawBusy ? '처리 중…' : '탈퇴 확인'}
                      </button>
                      <button type="button" className="staff-btn" onClick={cancelWithdraw}>
                        취소
                      </button>
                    </div>
                  </div>
                </section>
              ) : (
                <button
                  type="button"
                  className="staff-quiet-danger"
                  onClick={() => {
                    if (blockedForDemo('withdraw')) return;
                    setWithdrawOpen(true);
                  }}
                >
                  회원 탈퇴
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </StaffShell>
  );
}

type Msg = { tone: 'ok' | 'err'; text: string } | null;

function Notice({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <div className={msg.tone === 'ok' ? 'staff-alert staff-alert--ok' : 'staff-alert'}>{msg.text}</div>;
}

// 라벨은 입력칸 위
function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="staff-field">
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

// 설정 한 줄 — 왼쪽에 이름·값·설명, 오른쪽에 동작 단추, 아래에 펼치는 내용
function SettingRow({
  label,
  value,
  help,
  action,
  children,
}: {
  label: string;
  value?: ReactNode;
  help?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="staff-setting">
      <div className="staff-setting__row">
        <div className="staff-setting__main">
          <div className="staff-setting__label">{label}</div>
          {value ? <div className="staff-setting__value">{value}</div> : null}
          {help ? <div className="staff-setting__help">{help}</div> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
