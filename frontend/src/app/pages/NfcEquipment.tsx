import { useCallback, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import StaffShell from '../components/layout/StaffShell';
import { Button } from '../components/ui/button';
import { buildAuthHeaders, getStoredAuthSession, getStoredAuthUser, withRedirectQuery, LOGIN_PATH } from '../lib/auth';
import { useAuthGuard, useLogout, useRunWhenReady } from '../lib/useAuthGuard';
import { formatIBeaconTag } from '../lib/iBeaconTag';
import { API_BASE_URL } from '../lib/runtime';

type NfcEquipmentItem = {
  tag_id: string;
  equipment_name: string;
  equipment_type: string | null;
  nfc_token: string;
  asset_status: string;
  current_holder_user_id: number | null;
  current_holder_name: string | null;
  current_usage_id: number | null;
  reader_id: string | null;
  location: string | null;
  updated_at: number | null;
  is_stale: boolean;
};

function getAssetStatusLabel(status: string) {
  switch (status) {
    case 'checked_out':
      return '대여 중';
    case 'inactive':
      return '비활성';
    default:
      return '사용 가능';
  }
}

export default function NfcEquipment() {
  const location = useLocation();
  const params = useParams();
  const token = params.token ?? '';
  const [item, setItem] = useState<NfcEquipmentItem | null>(null);
  const [tapSession, setTapSession] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const currentUser = useMemo(() => getStoredAuthUser(), []);
  const currentAuthToken = useMemo(() => getStoredAuthSession()?.token ?? null, []);
  const isAuthorized = useAuthGuard(() => {
    // NFC URL 직진입 시 로그인 페이지로 보내더라도, 현재 진입 경로는 redirect로 보존한다.
    const loginRedirect = withRedirectQuery(LOGIN_PATH, `${location.pathname}${location.search}`);
    if (!currentUser || !currentAuthToken) return loginRedirect;
    if (currentUser.role !== 'admin' && currentUser.role !== 'staff') return loginRedirect;
    return null;
  });

  const logout = useLogout();

  const fetchItem = useCallback(
    async (nfcToken: string) => {
      setIsLoading(true);
      setError('');
      try {
        const authToken = getStoredAuthSession()?.token;
        if (!authToken) {
          logout();
          return;
        }
        const response = await fetch(`${API_BASE_URL}/nfc/${encodeURIComponent(nfcToken)}${location.search}`, {
          method: 'GET',
          cache: 'no-store',
          headers: buildAuthHeaders(authToken),
        });
        const payload = await response.json().catch(() => null);
        // 401만 로그인 만료다. 403은 탭이 무효하다는 뜻이라 세션을 버리면 안 된다 —
        // 3분 지난 탭 하나 때문에 멀쩡한 로그인이 날아간다.
        if (response.status === 401) {
          logout();
          return;
        }
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.detail ?? 'NFC 장비 정보를 불러오지 못했습니다.');
        }
        setItem((payload.item as NfcEquipmentItem) ?? null);
        setTapSession((payload.tap_session as string | null) ?? null);
      } catch (err) {
        setItem(null);
        if (err instanceof Error) setError(err.message);
        else setError('NFC 장비 조회 중 오류가 발생했습니다.');
      } finally {
        setIsLoading(false);
      }
    },
    [logout, location.search],
  );

  const runFetchItem = useCallback(() => {
    void fetchItem(token);
  }, [fetchItem, token]);
  useRunWhenReady(isAuthorized && Boolean(token), runFetchItem);

  const handleUsageAction = async (action: 'checkout' | 'return') => {
    if (!currentUser || !token) return;
    setIsSubmitting(true);
    setError('');
    setNotice('');
    try {
      const authToken = getStoredAuthSession()?.token;
      if (!authToken) {
        logout();
        return;
      }
      const response = await fetch(`${API_BASE_URL}/usage/${action}`, {
        method: 'POST',
        headers: buildAuthHeaders(authToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          nfc_token: token,
          tap_session: tapSession,
        }),
      });
      const payload = await response.json().catch(() => null);
      // 401만 로그인 만료다. 403은 탭이 무효하다는 뜻이라 세션을 버리면 안 된다 —
      // 3분 지난 탭 하나 때문에 멀쩡한 로그인이 날아간다.
      if (response.status === 401) {
        logout();
        return;
      }
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.detail ?? `장비 ${action === 'checkout' ? '사용 시작' : '사용 종료'}에 실패했습니다.`);
      }
      setNotice(
        action === 'checkout' ? '장비 상태가 대여 중으로 변경되었습니다.' : '장비 상태가 사용 가능으로 변경되었습니다.',
      );
      // 탭한 URL은 카운터가 소비돼 다시 읽을 수 없다. 응답이 실어 온 상태로 갱신한다.
      if (payload.item) setItem(payload.item as NfcEquipmentItem);
      // 탭 세션은 1회용이다 — 다음 동작을 하려면 태그를 다시 태깅해야 한다.
      setTapSession(null);
    } catch (err) {
      if (err instanceof Error) setError(err.message);
      else setError('장비 상태 변경 중 오류가 발생했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isHolder = Boolean(item && currentUser && item.current_holder_user_id === currentUser.user_id);
  const canCheckout = item?.asset_status === 'available';
  const canReturn = item?.asset_status === 'checked_out' && (isHolder || currentUser?.role === 'admin');

  if (!isAuthorized) {
    return null;
  }

  return (
    <StaffShell menu={currentUser?.role === 'admin' ? 'admin' : 'staff'}>
      <div className="staff-work staff-work__content staff-work__content--narrow">
        <header>
          <p className="staff-note mb-2">NFC 태깅</p>
          <h1 className="staff-me__name">{item?.equipment_name ?? '장비 정보'}</h1>
          {item ? <p className="staff-note mt-2">{formatIBeaconTag(item.tag_id)}</p> : null}
        </header>
        <section className="staff-panel staff-work__panel" aria-label="장비 정보">
          <dl className="staff-nfc-facts">
            <div>
              <dt>장비 상태</dt>
              <dd>{item ? getAssetStatusLabel(item.asset_status) : '-'}</dd>
            </div>
            <div>
              <dt>현재 위치</dt>
              <dd>{item?.location ?? '미수신'}</dd>
            </div>
            <div>
              <dt>스캔 토큰</dt>
              <dd>{token || '-'}</dd>
            </div>
          </dl>
        </section>
        <section className="staff-panel staff-work__panel" aria-label="장비 사용">
          {isLoading ? (
            <div className="staff-empty-block">장비 정보를 불러오는 중입니다.</div>
          ) : error ? (
            <div className="staff-alert" role="alert">
              {error}
            </div>
          ) : !item ? (
            <div className="staff-empty-block">매핑된 장비를 찾을 수 없습니다.</div>
          ) : (
            <div className="space-y-4">
              {notice ? (
                <div className="staff-alert staff-alert--ok" role="status">
                  {notice}
                </div>
              ) : null}

              <section className="staff-nfc-action">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <div className="staff-panel__title">장비 사용 상태 전환</div>
                    <div className="mt-2 text-sm text-muted-foreground">
                      {item.asset_status === 'available'
                        ? '이 장비는 현재 사용 가능합니다.'
                        : item.current_holder_name
                          ? `${item.current_holder_name} 사용자가 현재 대여 중입니다.`
                          : '현재 대여 중인 장비입니다.'}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Button
                      className="w-full sm:w-auto"
                      onClick={() => handleUsageAction('checkout')}
                      disabled={!canCheckout || isSubmitting || !tapSession}
                    >
                      {isSubmitting && canCheckout ? '처리 중...' : '사용 시작'}
                    </Button>
                    <Button
                      className="w-full sm:w-auto"
                      variant="outline"
                      onClick={() => handleUsageAction('return')}
                      disabled={!canReturn || isSubmitting || !tapSession}
                    >
                      {isSubmitting && canReturn ? '처리 중...' : '사용 종료'}
                    </Button>
                  </div>
                </div>
              </section>
            </div>
          )}
        </section>
      </div>
    </StaffShell>
  );
}
