import { useEffect, useState } from 'react';
import AppShell from '../components/layout/AppShell';
import AdminNav from '../components/layout/AdminNav';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { cn } from '../components/ui/utils';
import { API_BASE_URL } from '../lib/runtime';
import { buildAuthHeaders, getStoredAuthSession, LOGIN_PATH } from '../lib/auth';
import { useAuthGuard, useLogout } from '../lib/useAuthGuard';

type SignupRequestItem = {
  request_id: number;
  employee_no: string;
  display_name: string;
  email: string;
  created_at: string;
};

const POSITION_OPTIONS = ['간호사', '의사', '간호조무사', '방사선사', '임상병리사', '물리치료사', '기타'];
const ROLE_OPTIONS = [
  { value: 'staff', label: '의료진' },
  { value: 'admin', label: '관리자' },
] as const;
type ApproveRole = (typeof ROLE_OPTIONS)[number]['value'];

class UnauthorizedError extends Error {}

// 401은 세션 만료라 로그아웃시키고, 403(데모 관리자 등)은 서버 문구를 그대로 보여준다.
async function callAdminApi(path: string, init: RequestInit, fallbackMessage: string) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: buildAuthHeaders(getStoredAuthSession()?.token ?? null, { 'Content-Type': 'application/json' }),
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok || !payload?.ok) {
    throw new Error(typeof payload?.detail === 'string' ? payload.detail : fallbackMessage);
  }
  return payload;
}

function formatRequestedAt(iso: string) {
  return new Date(iso).toLocaleString('ko-KR', { hour12: false });
}

function requestSummary(item: SignupRequestItem) {
  return `${item.display_name} · ${item.employee_no} · ${item.email}`;
}

type DialogProps = {
  item: SignupRequestItem;
  onDone: (item: SignupRequestItem) => void;
  onClose: () => void;
  onUnauthorized: () => void;
};

function ApproveDialog({ item, onDone, onClose, onUnauthorized }: DialogProps) {
  const [role, setRole] = useState<ApproveRole>('staff');
  const [department, setDepartment] = useState('');
  const [position, setPosition] = useState('간호사');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const isAdminRole = role === 'admin';

  const approve = async () => {
    setError('');
    setIsSaving(true);
    try {
      await callAdminApi(
        `/admin/signup-requests/${item.request_id}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            role,
            department: isAdminRole ? null : department.trim() || null,
            position: isAdminRole ? null : position,
          }),
        },
        '가입 승인에 실패했습니다.',
      );
      onDone(item);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : '가입 승인 중 오류가 발생했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    // 저장 중에 닫으면 결과가 사라지고, 늦게 온 응답이 다른 요청의 대화상자를 닫는다.
    <Dialog open onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>가입 승인</DialogTitle>
          <DialogDescription>{requestSummary(item)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="alert alert-warn">
            사번·이름·이메일이 같은 직원의 것인지 확인한 뒤 승인하세요. 승인하면 이 이메일로 비밀번호 설정 링크가
            갑니다.
          </div>

          <div className="space-y-2">
            <Label>권한</Label>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="권한 선택">
              {ROLE_OPTIONS.map((option) => {
                const selected = role === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setRole(option.value)}
                    className={cn(
                      'flex h-11 items-center justify-center rounded-md border text-[0.98rem] transition-[border-color,background-color,color]',
                      'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 outline-none',
                      selected
                        ? 'border-primary bg-secondary font-medium text-foreground'
                        : 'border-input bg-input-background text-muted-foreground',
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          {!isAdminRole ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="approve-department">부서</Label>
                <Input
                  id="approve-department"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  placeholder="내과"
                />
              </div>

              <div className="space-y-2">
                <Label>직책</Label>
                <Select value={position} onValueChange={setPosition}>
                  <SelectTrigger>
                    <SelectValue placeholder="직책 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {POSITION_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : null}

          {error ? <div className="alert alert-error">{error}</div> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              취소
            </Button>
            <Button type="button" onClick={approve} disabled={isSaving}>
              승인하기
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ item, onDone, onClose, onUnauthorized }: DialogProps) {
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const reject = async () => {
    setError('');
    setIsSaving(true);
    try {
      await callAdminApi(
        `/admin/signup-requests/${item.request_id}`,
        { method: 'DELETE' },
        '가입 요청 거절에 실패했습니다.',
      );
      onDone(item);
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : '가입 요청 거절 중 오류가 발생했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    // 저장 중에 닫으면 결과가 사라지고, 늦게 온 응답이 다른 요청의 대화상자를 닫는다.
    <Dialog open onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>가입 요청 거절</DialogTitle>
          <DialogDescription>{requestSummary(item)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <p className="text-sm text-muted-foreground">요청을 지웁니다. 요청자에게는 알리지 않습니다.</p>
          {error ? <div className="alert alert-error">{error}</div> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              취소
            </Button>
            <Button type="button" variant="destructive" onClick={reject} disabled={isSaving}>
              거절하기
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export default function SignupRequests() {
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
  const logout = useLogout();
  const [items, setItems] = useState<SignupRequestItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [approving, setApproving] = useState<SignupRequestItem | null>(null);
  const [rejecting, setRejecting] = useState<SignupRequestItem | null>(null);

  useEffect(() => {
    if (!isAuthorized) return;
    let cancelled = false;
    callAdminApi('/admin/signup-requests', { method: 'GET' }, '가입 요청을 불러오지 못했습니다.')
      .then((payload) => {
        if (cancelled) return;
        setItems(Array.isArray(payload.items) ? payload.items : []);
        setIsLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) logout();
        else setError(err instanceof Error ? err.message : '가입 요청 조회 중 오류가 발생했습니다.');
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthorized, logout]);

  const removeItem = (item: SignupRequestItem) =>
    setItems((prev) => prev.filter((other) => other.request_id !== item.request_id));

  if (!isAuthorized) return null;

  return (
    <AppShell wide actions={<AdminNav active="signup-requests" />} contentClassName="pt-6 sm:pt-5">
      <section className="surface-panel p-5 fade-rise">
        <div className="panel-header">
          <div>
            <div className="panel-title">가입 승인</div>
          </div>
          <Badge variant="outline">{items.length}건</Badge>
        </div>
        {error ? <div className="alert alert-error mb-3">{error}</div> : null}
        {notice ? <div className="alert alert-success mb-3">{notice}</div> : null}
        {isLoaded && items.length === 0 ? <div className="empty-state">대기 중인 가입 요청이 없습니다.</div> : null}
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.request_id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 font-medium text-foreground">
                  <span>{item.display_name}</span>
                  <span className="text-sm text-muted-foreground">{item.employee_no}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <span>{item.email}</span> · 요청 {formatRequestedAt(item.created_at)}
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={() => setApproving(item)}>
                  승인
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setRejecting(item)}>
                  거절
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {approving ? (
        <ApproveDialog
          item={approving}
          onClose={() => setApproving(null)}
          onUnauthorized={logout}
          onDone={(item) => {
            removeItem(item);
            setApproving(null);
            setNotice('승인했습니다. 메일이 오지 않으면 요청자에게 비밀번호 찾기를 안내하세요.');
          }}
        />
      ) : null}
      {rejecting ? (
        <RejectDialog
          item={rejecting}
          onClose={() => setRejecting(null)}
          onUnauthorized={logout}
          onDone={(item) => {
            removeItem(item);
            setRejecting(null);
            setNotice('');
          }}
        />
      ) : null}
    </AppShell>
  );
}
