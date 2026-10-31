import { useEffect, useMemo, useState } from 'react';
import StaffShell from '../components/layout/StaffShell';
import { ToggleSwitch } from '../components/layout/staffControls';
import ProvenanceDot from '../components/ui/ProvenanceDot';
import { formatIBeaconTag } from '../lib/iBeaconTag';
import { API_BASE_URL } from '../lib/runtime';
import { buildAuthHeaders, getStoredAuthSession, LOGIN_PATH } from '../lib/auth';
import { useAuthGuard, useLogout } from '../lib/useAuthGuard';

type LiveReaderItem = {
  reader_id: string;
  location: string;
  is_online: boolean;
  last_seen: number | null;
  is_real_hardware?: boolean;
};

type LiveTagItem = {
  tag_id: string;
  equipment_name: string | null;
  reader_id: string | null;
  location: string | null;
  is_online: boolean;
  last_seen: number | null;
  is_real_hardware?: boolean;
};

function dotClass(isOnline: boolean) {
  return isOnline ? 'staff-led' : 'staff-led staff-led--off';
}

function formatSeen(epoch: number | null) {
  if (!epoch) return '-';
  return new Date(epoch * 1000).toLocaleString('ko-KR', { hour12: false });
}

export default function DeviceStatus() {
  const isAuthorized = useAuthGuard(() => {
    try {
      const session = getStoredAuthSession();
      if (!session?.token || !session.user) return LOGIN_PATH;
      if (session.user.role !== 'admin') return '/equipment';
      return null;
    } catch {
      return LOGIN_PATH;
    }
  });
  const [readers, setReaders] = useState<LiveReaderItem[]>([]);
  const [tags, setTags] = useState<LiveTagItem[]>([]);
  const [error, setError] = useState('');
  const [hideSimulated, setHideSimulated] = useState(false);

  const logout = useLogout();

  useEffect(() => {
    if (!isAuthorized) return;
    let cancelled = false;

    const fetchLive = async () => {
      try {
        const session = getStoredAuthSession();
        if (!session?.token) {
          logout();
          return;
        }
        const response = await fetch(`${API_BASE_URL}/rtls/live`, {
          method: 'GET',
          cache: 'no-store',
          headers: buildAuthHeaders(session.token),
        });
        const payload = await response.json().catch(() => null);
        if (response.status === 401 || response.status === 403) {
          logout();
          return;
        }
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.detail ?? '기기 상태를 가져오지 못했습니다.');
        }
        if (cancelled) return;
        setReaders(Array.isArray(payload.readers) ? payload.readers : []);
        setTags(Array.isArray(payload.items) ? payload.items : []);
        setError('');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error) setError(err.message);
        else setError('기기 상태 조회 중 오류가 발생했습니다.');
      }
    };

    fetchLive();
    const intervalId = window.setInterval(fetchLive, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isAuthorized, logout]);

  const visibleReaders = useMemo(
    () => (hideSimulated ? readers.filter((r) => r.is_real_hardware !== false) : readers),
    [readers, hideSimulated],
  );
  const visibleTags = useMemo(
    () => (hideSimulated ? tags.filter((t) => t.is_real_hardware !== false) : tags),
    [tags, hideSimulated],
  );
  const readersTotal = visibleReaders.length;
  const tagsTotal = visibleTags.length;
  const readersOnline = visibleReaders.filter((reader) => reader.is_online).length;
  const tagsOnline = visibleTags.filter((tag) => tag.is_online).length;
  const sortedTags = useMemo(
    () => [...visibleTags].sort((a, b) => Number(b.is_online) - Number(a.is_online)),
    [visibleTags],
  );

  if (!isAuthorized) return null;

  return (
    <StaffShell menu="admin" current="devices">
      <div className="staff-work staff-work__content">
        <header className="staff-work__heading">
          <div>
            <h1 className="staff-title">기기 상태</h1>
            <p className="staff-note mt-2">리더 연결과 태그 수신 상태 · 3초마다 갱신</p>
          </div>
          <ToggleSwitch checked={hideSimulated} onChange={setHideSimulated}>
            시뮬레이션 데이터 숨기기
          </ToggleSwitch>
        </header>
        {error ? (
          <div className="staff-alert" role="alert">
            {error}
          </div>
        ) : null}
        <div className="staff-device-summary">
          <section className="staff-panel staff-device-metric">
            <h2 className="staff-note">리더 온라인</h2>
            <div>
              <strong>{`${readersOnline} / ${readersTotal}`}</strong>
            </div>
          </section>
          <section className="staff-panel staff-device-metric">
            <h2 className="staff-note">태그 감지</h2>
            <div>
              <strong>{`${tagsOnline} / ${tagsTotal}`}</strong>
            </div>
          </section>
        </div>

        <div className="staff-device-grid">
          <section className="staff-panel staff-work__panel">
            <div className="staff-panel__head">
              <h2 className="staff-panel__title">리더</h2>
              <span className="staff-note">{readersTotal}대</span>
            </div>
            {readersTotal === 0 ? (
              <div className="staff-empty-block">등록된 리더가 없습니다.</div>
            ) : (
              visibleReaders.map((r) => (
                <div key={r.reader_id} className="staff-device-row">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-semibold">
                      {r.location}
                      <ProvenanceDot isRealHardware={r.is_real_hardware ?? true} />
                    </div>
                    <div className="staff-note mt-1">{r.reader_id}</div>
                  </div>
                  <div className="staff-device-row__state">
                    <div className="staff-status">
                      <span className={dotClass(r.is_online)} />
                      {r.is_online ? '온라인' : '오프라인'}
                    </div>
                    <div className="staff-note mt-1">마지막 수신: {formatSeen(r.last_seen)}</div>
                  </div>
                </div>
              ))
            )}
          </section>

          <section className="staff-panel staff-work__panel">
            <div className="staff-panel__head">
              <h2 className="staff-panel__title">태그</h2>
              <span className="staff-note">{tagsTotal}개</span>
            </div>
            {tagsTotal === 0 ? (
              <div className="staff-empty-block">등록된 태그가 없습니다.</div>
            ) : (
              sortedTags.map((t) => (
                <div key={t.tag_id} className="staff-device-row">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-semibold">
                      {t.equipment_name?.trim() || t.tag_id}
                      <ProvenanceDot isRealHardware={t.is_real_hardware ?? true} />
                    </div>
                    <div className="staff-note mt-1" title={t.tag_id}>
                      {formatIBeaconTag(t.tag_id)} · {t.location ?? '감지 안 됨'}
                    </div>
                  </div>
                  <div className="staff-device-row__state">
                    <div className="staff-status">
                      <span className={dotClass(t.is_online)} />
                      {t.is_online ? '감지 중' : '감지 안 됨'}
                    </div>
                    <div className="staff-note mt-1">마지막 수신: {formatSeen(t.last_seen)}</div>
                  </div>
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </StaffShell>
  );
}
