import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../components/ui/badge';
import AppShell from '../components/layout/AppShell';
import AdminNav from '../components/layout/AdminNav';
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
  return isOnline ? 'h-2.5 w-2.5 rounded-full dot-ok' : 'h-2.5 w-2.5 rounded-full dot-warn';
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
    <AppShell wide actions={<AdminNav active="devices" />} contentClassName="pt-6 sm:pt-5">
      <div className="space-y-4">
        <section className="surface-panel p-5 fade-rise">
          <div className="panel-header">
            <div>
              <div className="panel-title">기기 상태</div>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={hideSimulated}
                onChange={(event) => setHideSimulated(event.target.checked)}
              />
              시뮬레이션 데이터 숨기기
            </label>
          </div>
          {error ? <div className="alert alert-error mb-3">{error}</div> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="metric-label">리더 온라인</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em]">
                {readersOnline} / {readersTotal}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="metric-label">태그 감지</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em]">
                {tagsOnline} / {tagsTotal}
              </div>
            </div>
          </div>
        </section>

        <section className="surface-panel p-5 fade-rise">
          <div className="panel-header">
            <div>
              <div className="panel-title">리더</div>
            </div>
            <Badge variant="outline">{readersTotal}대</Badge>
          </div>
          <div className="space-y-2">
            {readersTotal === 0 ? (
              <div className="empty-state">등록된 리더가 없습니다.</div>
            ) : (
              visibleReaders.map((r) => (
                <div
                  key={r.reader_id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      {r.location}
                      <ProvenanceDot isRealHardware={r.is_real_hardware ?? true} />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{r.reader_id}</div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div className="flex items-center justify-end gap-2">
                      <span className={dotClass(r.is_online)} />
                      {r.is_online ? '온라인' : '오프라인'}
                    </div>
                    <div className="mt-1">마지막 수신: {formatSeen(r.last_seen)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="surface-panel p-5 fade-rise">
          <div className="panel-header">
            <div>
              <div className="panel-title">태그</div>
            </div>
            <Badge variant="outline">{tagsTotal}개</Badge>
          </div>
          <div className="space-y-2">
            {tagsTotal === 0 ? (
              <div className="empty-state">등록된 태그가 없습니다.</div>
            ) : (
              sortedTags.map((t) => (
                <div
                  key={t.tag_id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 truncate font-medium text-foreground">
                      {t.equipment_name?.trim() || t.tag_id}
                      <ProvenanceDot isRealHardware={t.is_real_hardware ?? true} />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground" title={t.tag_id}>
                      {formatIBeaconTag(t.tag_id)} · {t.location ?? '감지 안 됨'}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div className="flex items-center justify-end gap-2">
                      <span className={dotClass(t.is_online)} />
                      {t.is_online ? '감지 중' : '감지 안 됨'}
                    </div>
                    <div className="mt-1">마지막 수신: {formatSeen(t.last_seen)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
