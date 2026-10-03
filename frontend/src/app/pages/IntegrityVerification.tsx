import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import AppShell from '../components/layout/AppShell';
import AdminNav from '../components/layout/AdminNav';
import ResizableSidebar from '../components/layout/ResizableSidebar';
import Pagination from '../components/ui/Pagination';
import { DEFAULT_PAGE_SIZE } from '../lib/pagination';
import { formatIBeaconTag } from '../lib/iBeaconTag';
import { API_BASE_URL } from '../lib/runtime';
import { buildAuthHeaders, getStoredAuthSession, LOGIN_PATH } from '../lib/auth';
import { useAuthGuard, useLogout, useRunWhenReady } from '../lib/useAuthGuard';
import { useMediaQuery } from '../lib/useMediaQuery';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  HelpCircle,
  Loader2,
  Printer,
  User,
} from 'lucide-react';

// 사이드바가 결과 옆에 나란히 붙는 시점(xl) — 그 미만에서는 사이드바 대신
// "상세검색" 토글로 접고 펼치는 폼을 쓴다.
const DESKTOP_QUERY = '(min-width: 1280px)';

type MovementPoint = { location: string; at: number };

type UsageChainRecord = {
  usageId: string;
  checkoutUserId: number | null;
  returnUserId: number | null;
  tagId: string;
  checkoutLocation: string;
  checkoutAt: number | null;
  returnLocation: string;
  returnedAt: number | null;
  movementPath: MovementPoint[];
};

type UsageHistoryItem = {
  usage_id: number;
  user: {
    name: string;
    position: string | null;
    department: string | null;
  };
  returned_by: {
    name: string | null;
    position: string | null;
    department: string | null;
  };
  equipment: {
    tag_id: string;
    name: string;
    // 관리자만 받는 값. 예전 응답에는 없을 수 있어 optional.
    is_real_hardware?: boolean;
  };
  checkout: {
    reader_id: string | null;
    location: string | null;
    at: number | null;
  };
  return: {
    reader_id: string | null;
    location: string | null;
    at: number | null;
  };
  movement_path: MovementPoint[];
  blockchain: {
    verification_status: string;
    verification_label: string;
    db_record: UsageChainRecord | null;
    tx_input_matches_db: boolean | null;
    transactions_root_matches: boolean | null;
    anchor: {
      block_number: number | null;
      transaction_index: number | null;
      transactions_root: string | null;
      recalculated_transactions_root: string | null;
    } | null;
  } | null;
};

type SortField = 'time' | 'user' | 'equipment';
type SortOrder = 'asc' | 'desc';

type HistoryFilters = {
  user: string;
  equipment: string;
  checkoutLocation: string;
  returnLocation: string;
  startDate: string;
  endDate: string;
  sortField: SortField;
  sortOrder: SortOrder;
};

/** 서버 한 페이지를 특정하는 값 전부. 이 값이 곧 요청 파라미터가 된다. */
type HistoryQuery = {
  filters: HistoryFilters;
  page: number;
  pageSize: number;
  hideSimulated: boolean;
  includeInUse: boolean;
};

const SORT_FIELD_OPTIONS: Array<{ value: SortField; label: string }> = [
  { value: 'time', label: '시간 순' },
  { value: 'user', label: '이름 순' },
  { value: 'equipment', label: '장비 이름 순' },
];

const SORT_ORDER_OPTIONS: Array<{ value: SortOrder; label: string }> = [
  { value: 'desc', label: '내림차순' },
  { value: 'asc', label: '오름차순' },
];

const DEFAULT_FILTERS: HistoryFilters = {
  user: '',
  equipment: '',
  checkoutLocation: '',
  returnLocation: '',
  startDate: '',
  endDate: '',
  sortField: 'time',
  sortOrder: 'desc',
};

const DEFAULT_QUERY: HistoryQuery = {
  filters: DEFAULT_FILTERS,
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  hideSimulated: false,
  // 반납 전 이력은 검증할 게 없어 기본은 감춘다.
  includeInUse: false,
};

/** CSV 한 번에 받아올 건수. 서버는 include_blockchain일 때 limit을 200으로 자르므로 그 값에 맞춘다. */
const CSV_CHUNK_SIZE = 200;

function buildHistoryParams(query: HistoryQuery, { includeBlockchain }: { includeBlockchain: boolean }) {
  const { filters, page, pageSize, hideSimulated, includeInUse } = query;
  const params = new URLSearchParams({
    sort_by: filters.sortField,
    sort_order: filters.sortOrder,
    limit: String(pageSize),
    offset: String((page - 1) * pageSize),
    include_in_use: String(includeInUse),
    include_blockchain: String(includeBlockchain),
  });
  if (hideSimulated) params.set('hide_simulated', 'true');
  if (filters.user.trim()) params.set('user', filters.user.trim());
  if (filters.equipment.trim()) params.set('equipment', filters.equipment.trim());
  if (filters.checkoutLocation.trim()) params.set('checkout_location', filters.checkoutLocation.trim());
  if (filters.returnLocation.trim()) params.set('return_location', filters.returnLocation.trim());
  if (filters.startDate) params.set('start_date', filters.startDate);
  if (filters.endDate) params.set('end_date', filters.endDate);
  return params;
}

/** 조회 중 결과 카드 자리를 대신 채우는 자리표시자. 개수는 첫 페이지가 비어 보이지 않을 만큼만. */
function HistorySkeleton() {
  return (
    <div
      data-testid="history-skeleton"
      role="status"
      aria-label="사용 이력을 불러오는 중입니다"
      className="space-y-2.5"
    >
      {/* 조회가 느린 이유를 설명해 둔다 — 단순 DB 조회가 아니라 기록마다 체인을 되짚는 작업이다. */}
      <div
        data-testid="history-loading-notice"
        className="flex items-start gap-3 border border-border/70 bg-secondary/40 px-5 py-4"
      >
        <Loader2 className="mt-1 h-5 w-5 shrink-0 animate-spin text-primary" />
        <div>
          <div className="text-[1.1rem] font-semibold tracking-[-0.02em] text-foreground">
            블록체인에서 사용 이력을 검증하는 중입니다
          </div>
          <p className="mt-1.5 text-[0.98rem] leading-relaxed text-muted-foreground">
            한 건씩 온체인 값과 대조하고 그 기록이 담긴 블록의 머클루트를 다시 계산하기 때문에 결과가 나오기까지 수십
            초가 걸릴 수 있습니다.
          </p>
        </div>
      </div>

      {/* 결과 행과 같은 두 줄 높이로 맞춘다 — 다르면 로딩에서 결과로 넘어갈 때 화면이 크게 튄다 */}
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          data-testid="history-skeleton-card"
          className="relative flex flex-col gap-1 overflow-hidden border border-border bg-card py-2.5 pl-5 pr-4"
        >
          <div className="skeleton absolute left-0 top-0 h-full w-1.5 border-0" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="skeleton h-5 w-40" />
              <div className="skeleton h-4 w-48" />
            </div>
            <div className="skeleton h-6 w-24" />
          </div>
          <div className="skeleton h-4 w-3/4" />
        </div>
      ))}
    </div>
  );
}

function formatDateTime(epoch: number | null | undefined) {
  if (!epoch) return '-';
  const date = new Date(epoch * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}년 ${month}월 ${day}일 ${hours}시 ${minutes}분 ${seconds}초`;
}

/** 목록 행 전용 축약 포맷. 전체 포맷은 한 줄에 대여·반납 두 개가 들어가지 않는다. */
function formatCompactDateTime(epoch: number | null | undefined) {
  if (!epoch) return '-';
  const date = new Date(epoch * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/** '이름(부서)' — 부서가 없으면 이름만. 행에서 괄호만 덩그러니 남는 걸 막는다. */
function formatPerson(name: string | null, department: string | null) {
  const displayName = name ?? '-';
  return department ? `${displayName}(${department})` : displayName;
}

function formatDownloadTimestamp(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

function escapeCsvCell(value: string | number | null | undefined) {
  const text = value == null ? '' : String(value);
  const safeText = /^[=+@-]/.test(text.replace(/^[\s\p{Cc}]*/u, '')) ? `'${text}` : text;
  if (!/[",\n\r]/.test(safeText)) return safeText;
  return `"${safeText.replace(/"/g, '""')}"`;
}

function getLocationLabel(location: string | null, readerId: string | null) {
  return location ?? readerId ?? '-';
}

function getOnchainRecordNotice(value: boolean | null | undefined) {
  if (value === true) return '온체인 원문 일치';
  if (value === false) return '온체인 원문 불일치';
  return '온체인 원문 비교 불가';
}

function getMerkleVerificationNotice(value: boolean | null | undefined) {
  if (value === true) return '머클루트 일치';
  if (value === false) return '머클루트 불일치';
  return '머클루트 검증 불가';
}

function VerificationNotice({ value, children }: { value: boolean | null | undefined; children: string }) {
  const Icon = value === true ? CheckCircle2 : value === false ? AlertTriangle : HelpCircle;
  const iconTone = value === true ? 'text-ok' : value === false ? 'text-err' : 'text-muted-foreground';

  return (
    <div className="mt-3 flex items-center gap-2 border-t border-border/70 pt-3 text-[0.92rem] font-medium text-muted-foreground">
      <Icon className={`h-4 w-4 shrink-0 ${iconTone}`} />
      <span>{children}</span>
    </div>
  );
}

function getDisplayDepartment(item: UsageHistoryItem) {
  return item.user.department ?? '-';
}

function getDisplayPosition(item: UsageHistoryItem) {
  return item.user.position ?? '-';
}

function getDisplayReturnedByDepartment(item: UsageHistoryItem) {
  return item.returned_by.department ?? '-';
}

function getDisplayReturnedByPosition(item: UsageHistoryItem) {
  return item.returned_by.position ?? '-';
}

function getStatusTone(status: string) {
  if (status === 'verified') {
    return 'tone-ok';
  }
  if (status === 'not_eligible') {
    return 'tone-neutral';
  }
  if (status === 'chain_error' || status === 'not_configured') {
    return 'tone-warn';
  }
  return 'tone-err';
}

function getVerificationCardTone(status: string) {
  if (status === 'verified') return 'solid-ok';
  if (status === 'not_eligible') return 'solid-neutral';
  if (status === 'chain_error' || status === 'not_configured') return 'solid-warn';
  return 'solid-err';
}

/** 상태 뱃지. 글자만 둔다 — 라벨이 상태를 다 말하고, 톤 색이 강약을 준다. */
function VerificationStatusPill({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2.5 py-1 text-[0.82rem] font-semibold ${getStatusTone(status)}`}
    >
      {label}
    </span>
  );
}

/** CSV의 검증 결과 칸. 사용 중인 이력은 애초에 내보내지 않으므로 두 값이면 충분하다. */
function getCsvVerificationResult(status: string | undefined) {
  return status === 'verified' ? '성공' : '실패';
}

/** 발급 대장이 따로 없으므로 문서번호는 usage_id에서만 파생한다. */
function formatDocumentNumber(usageId: number) {
  return `UR-${String(usageId).padStart(6, '0')}`;
}

/** 타임라인 노드에 붙는 '이름 · 부서 · 직책'. 비어 있는 칸은 '-'로 채워 열이 밀리지 않게 한다. */
function formatHandler(name: string | null, department: string, position: string) {
  return [name ?? '-', department, position].join(' · ');
}

type CertificateField = { label: string; value: ReactNode };

/** 증명서의 한 절. 로마 숫자·제목·규칙선으로 묶어 문서의 조항처럼 읽히게 한다. */
function CertificateSection({ numeral, title, children }: { numeral: string; title: string; children: ReactNode }) {
  return (
    <section role="group" aria-label={title} className="certificate-section">
      <div className="certificate-section__head">
        <span className="certificate-section__numeral">{numeral}</span>
        <span className="certificate-section__title">{title}</span>
      </div>
      <div className="certificate-section__body">{children}</div>
    </section>
  );
}

/** 레이블 열과 값 열을 맞춘 정의 목록. 값이 위아래로 정렬돼야 기록물처럼 읽힌다. */
function CertificateFields({ fields, split = false }: { fields: CertificateField[]; split?: boolean }) {
  return (
    <dl className={`certificate-fields${split ? ' certificate-fields--split' : ''}`}>
      {fields.map((field) => (
        <div key={field.label} className="certificate-fields__row">
          <dt className="certificate-fields__label">{field.label}</dt>
          <dd className="certificate-fields__value">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 머클 루트 같은 기계값 — 등폭으로 고정하고 그대로 복사할 수 있게 한다. */
function HashValue({ value }: { value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const copy = () => {
    if (!value) return;
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span className="certificate-hash">
      <code className="certificate-hash__value">{value ?? '-'}</code>
      {value ? (
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? '복사됨' : '값 복사'}
          className="certificate-hash__copy"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      ) : null}
    </span>
  );
}

/** 대여 → 경유 → 반납을 한 줄기로 잇는다. 4칸으로 흩어져 있던 사람·장소·시각이 여기 모인다. */
function RecordTimeline({ item }: { item: UsageHistoryItem }) {
  const transit = item.movement_path ?? [];

  return (
    <ol aria-label="사용 기록 타임라인" className="certificate-timeline">
      <li className="certificate-timeline__step certificate-timeline__step--end">
        <span className="certificate-timeline__marker" aria-hidden="true" />
        <span className="certificate-timeline__label">대여</span>
        <span className="certificate-timeline__time">{formatDateTime(item.checkout.at)}</span>
        <span className="certificate-timeline__place">
          {getLocationLabel(item.checkout.location, item.checkout.reader_id)}
        </span>
        <span className="certificate-timeline__person">
          <span className="certificate-timeline__role">대여자</span>
          {formatHandler(item.user.name, getDisplayDepartment(item), getDisplayPosition(item))}
        </span>
      </li>

      {transit.length === 0 ? (
        <li className="certificate-timeline__step certificate-timeline__step--empty">
          <span className="certificate-timeline__marker" aria-hidden="true" />
          <span className="certificate-timeline__label">경유</span>
          <span className="certificate-timeline__place">이동 기록 없음</span>
        </li>
      ) : (
        transit.map((point, index) => (
          <li key={`${point.location}-${point.at}-${index}`} className="certificate-timeline__step">
            <span className="certificate-timeline__marker" aria-hidden="true" />
            <span className="certificate-timeline__label">경유 {index + 1}</span>
            <span className="certificate-timeline__time">{formatDateTime(point.at)}</span>
            <span className="certificate-timeline__place">{point.location}</span>
          </li>
        ))
      )}

      <li className="certificate-timeline__step certificate-timeline__step--end">
        <span className="certificate-timeline__marker" aria-hidden="true" />
        <span className="certificate-timeline__label">반납</span>
        <span className="certificate-timeline__time">{formatDateTime(item.return.at)}</span>
        <span className="certificate-timeline__place">
          {getLocationLabel(item.return.location, item.return.reader_id)}
        </span>
        <span className="certificate-timeline__person">
          <span className="certificate-timeline__role">반납자</span>
          {formatHandler(
            item.returned_by.name,
            getDisplayReturnedByDepartment(item),
            getDisplayReturnedByPosition(item),
          )}
        </span>
      </li>
    </ol>
  );
}

/** 목록의 한 건. 두 줄로 압축하고, 온체인 원문·머클 값은 팝업에만 둔다. */
function UsageHistoryRow({ item, onOpen }: { item: UsageHistoryItem; onOpen: () => void }) {
  const blockchain = item.blockchain;
  const blockNumber = blockchain?.anchor?.block_number ?? null;
  const transactionIndex = blockchain?.anchor?.transaction_index ?? null;
  const verificationStatus = blockchain?.verification_status ?? 'chain_error';
  const verificationLabel = blockchain?.verification_label ?? '검증 중 오류';

  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative flex w-full flex-col gap-1 overflow-hidden border border-border bg-card py-2.5 pl-5 pr-4 text-left transition-colors hover:bg-secondary/50"
    >
      <span className={`absolute left-0 top-0 h-full w-1.5 ${getVerificationCardTone(verificationStatus)}`} />

      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex flex-wrap items-baseline gap-x-2.5">
          <span className="text-[1.05rem] font-semibold tracking-[-0.03em] text-foreground">{item.equipment.name}</span>
          <span className="text-[0.88rem] text-muted-foreground">
            #{item.usage_id} · {formatIBeaconTag(item.equipment.tag_id)}
          </span>
        </span>
        <span className="flex flex-wrap items-center justify-end gap-1.5">
          {typeof blockNumber === 'number' ? <Badge variant="outline">Block {blockNumber}</Badge> : null}
          {typeof transactionIndex === 'number' ? <Badge variant="outline">Tx #{transactionIndex}</Badge> : null}
          <VerificationStatusPill status={verificationStatus} label={verificationLabel} />
        </span>
      </span>

      <span className="flex flex-wrap items-center gap-x-2 text-[0.9rem] leading-5 text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <User className="h-3.5 w-3.5 shrink-0" />
          {formatPerson(item.user.name, item.user.department)} →{' '}
          {formatPerson(item.returned_by.name, item.returned_by.department)}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {getLocationLabel(item.checkout.location, item.checkout.reader_id)} →{' '}
          {getLocationLabel(item.return.location, item.return.reader_id)}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {formatCompactDateTime(item.checkout.at)} ~ {formatCompactDateTime(item.return.at)}
        </span>
      </span>
    </button>
  );
}

/** CSV를 만드는 동안 띄우는 진행 모달. 온체인 대조 때문에 수십 초가 걸려, 멈춘 게 아니라는 신호가 필요하다. */
function CsvProgressDialog({ progress }: { progress: { received: number; total: number } | null }) {
  const total = progress?.total ?? 0;
  const received = progress?.received ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

  return (
    <Dialog open={Boolean(progress)}>
      <DialogContent
        className="csv-progress max-w-md"
        // 닫아도 작업은 계속 돌아 화면에만 안 보이게 된다 — 아예 닫히지 않게 막는다.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="flex flex-col items-center text-center">
          <Loader2 className="h-7 w-7 animate-spin text-primary" aria-hidden="true" />
          <DialogTitle className="pt-2">CSV를 준비하는 중입니다</DialogTitle>
          <DialogDescription>
            기록마다 온체인 값을 대조하고 그 기록이 담긴 블록의 머클루트를 다시 계산하기 때문에 수십 초가 걸릴 수
            있습니다.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-2 text-center">
          {total > 0 ? (
            <>
              <div className="text-[1rem] font-semibold text-foreground">
                {total}건 중 {received}건 내려받았습니다
              </div>
              <div
                className="csv-progress__track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={received}
              >
                <div className="csv-progress__bar" style={{ width: `${percent}%` }} />
              </div>
              <div className="text-[0.85rem] text-muted-foreground">{percent}%</div>
            </>
          ) : (
            <div className="text-[0.95rem] text-muted-foreground">전체 건수를 확인하는 중입니다…</div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** 한 건의 전체 기록을 검증 증명서 형식으로 발급한다. 정보는 네 개 절로 나뉘고 하나도 생략하지 않는다. */
function UsageDetailDialog({ item, onClose }: { item: UsageHistoryItem | null; onClose: () => void }) {
  const blockchain = item?.blockchain;
  const verificationStatus = blockchain?.verification_status ?? 'chain_error';
  const verificationLabel = blockchain?.verification_label ?? '검증 중 오류';
  const record = blockchain?.db_record ?? null;
  const anchor = blockchain?.anchor ?? null;
  const onchainNotice = getOnchainRecordNotice(blockchain?.tx_input_matches_db);
  const merkleNotice = getMerkleVerificationNotice(blockchain?.transactions_root_matches);

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => (open ? undefined : onClose())}>
      {/* 온체인 해시가 길어 기본 max-w-2xl에서는 줄바꿈이 심하다 */}
      <DialogContent className="certificate max-w-4xl" aria-describedby={undefined}>
        {item ? (
          <>
            <DialogHeader className="certificate__header pr-12">
              <DialogTitle className="certificate__title">의료 장비 사용 이력 검증 증명서</DialogTitle>
              <div role="group" aria-label="증명서 발급 정보" className="certificate__meta">
                <div className="certificate__meta-item">
                  <span className="certificate__meta-label">문서번호</span>
                  <span className="certificate__meta-value">{formatDocumentNumber(item.usage_id)}</span>
                </div>
                <VerificationStatusPill status={verificationStatus} label={verificationLabel} />
              </div>
            </DialogHeader>

            <DialogBody className="certificate__body">
              <CertificateSection numeral="Ⅰ" title="장비">
                <ul aria-label="장비 식별 정보" className="certificate-identity">
                  {[
                    { label: '장비명', value: item.equipment.name },
                    { label: '태그', value: formatIBeaconTag(item.equipment.tag_id) },
                    { label: 'usage_id', value: String(item.usage_id) },
                  ].map((field) => (
                    <li key={field.label} className="certificate-identity__item">
                      <span className="certificate-identity__label">{field.label}</span>
                      <span className="certificate-identity__value">{field.value}</span>
                    </li>
                  ))}
                </ul>
              </CertificateSection>

              <CertificateSection numeral="Ⅱ" title="사용 기록">
                <RecordTimeline item={item} />
              </CertificateSection>

              <CertificateSection numeral="Ⅲ" title="의료 장비 사용 이력">
                {!record ? (
                  <div className="certificate-empty">기록 없음</div>
                ) : (
                  <>
                    <CertificateFields
                      split
                      fields={[
                        { label: 'usage_id', value: record.usageId },
                        { label: '태그', value: formatIBeaconTag(record.tagId ?? '') },
                        { label: '사용 시작자 ID', value: record.checkoutUserId ?? '-' },
                        { label: '사용 종료자 ID', value: record.returnUserId ?? '-' },
                        { label: '대여 위치', value: record.checkoutLocation || '-' },
                        { label: '반납 위치', value: record.returnLocation || '-' },
                        { label: '대여 시각', value: formatDateTime(record.checkoutAt) },
                        { label: '반납 시각', value: formatDateTime(record.returnedAt) },
                      ]}
                    />
                    <VerificationNotice value={blockchain?.tx_input_matches_db}>{onchainNotice}</VerificationNotice>
                  </>
                )}
              </CertificateSection>

              <CertificateSection numeral="Ⅳ" title="머클 검증 결과">
                <CertificateFields
                  fields={[
                    { label: '블록 번호', value: anchor?.block_number ?? '-' },
                    { label: '트랜잭션 인덱스', value: anchor?.transaction_index ?? '-' },
                    { label: '원본 머클 루트 값', value: <HashValue value={anchor?.transactions_root} /> },
                    {
                      label: '재계산 머클 루트 값',
                      value: <HashValue value={anchor?.recalculated_transactions_root} />,
                    },
                  ]}
                />
                <VerificationNotice value={blockchain?.transactions_root_matches}>{merkleNotice}</VerificationNotice>
              </CertificateSection>

              <div className="certificate__actions">
                <Button type="button" variant="outline" onClick={() => window.print()}>
                  <Printer className="h-4 w-4" />
                  인쇄
                </Button>
              </div>
            </DialogBody>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default function IntegrityVerification() {
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
  // 입력 중인 조건. 조회를 눌러야 query로 넘어간다.
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  // 서버에 실제로 보낸 조회 조건. 이 값이 바뀔 때마다 한 페이지씩 다시 받아온다.
  const [query, setQuery] = useState<HistoryQuery>(DEFAULT_QUERY);
  const [items, setItems] = useState<UsageHistoryItem[]>([]);
  const historyRequestId = useRef(0);
  useEffect(
    () => () => {
      historyRequestId.current += 1;
    },
    [],
  );
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailUsageId, setDetailUsageId] = useState<number | null>(null);
  // null이면 모달이 닫힌 상태. 내보내는 동안만 값이 들어간다.
  const [csvProgress, setCsvProgress] = useState<{ received: number; total: number } | null>(null);
  const [locationOptions, setLocationOptions] = useState<Array<{ value: string; label: string }>>([]);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);

  const logout = useLogout();

  const updateFilter = <K extends keyof HistoryFilters>(key: K, value: HistoryFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const updateStartDate = (value: string) => {
    setFilters((prev) => ({
      ...prev,
      startDate: value,
      endDate: prev.endDate && value && prev.endDate < value ? value : prev.endDate,
    }));
  };

  const updateEndDate = (value: string) => {
    setFilters((prev) => ({
      ...prev,
      startDate: prev.startDate && value && prev.startDate > value ? value : prev.startDate,
      endDate: value,
    }));
  };

  const fetchHistory = useCallback(
    async (targetQuery: HistoryQuery) => {
      const requestId = ++historyRequestId.current;
      setIsLoading(true);
      setError('');
      try {
        const session = getStoredAuthSession();
        if (!session?.token) {
          logout();
          return;
        }

        const response = await fetch(
          `${API_BASE_URL}/usage/history?${buildHistoryParams(targetQuery, { includeBlockchain: true }).toString()}`,
          {
            method: 'GET',
            cache: 'no-store',
            headers: buildAuthHeaders(session.token),
          },
        );
        const payload = await response.json().catch(() => null);
        if (requestId !== historyRequestId.current) return;
        if (response.status === 401 || response.status === 403) {
          logout();
          return;
        }
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.detail ?? '사용 이력 무결성 검증 조회에 실패했습니다.');
        }

        setItems(Array.isArray(payload.items) ? (payload.items as UsageHistoryItem[]) : []);
        setTotal(typeof payload.total === 'number' ? payload.total : 0);
        setDetailUsageId(null);
      } catch (err) {
        if (requestId !== historyRequestId.current) return;
        if (err instanceof Error) setError(err.message);
        else setError('사용 이력 무결성 검증 조회 중 오류가 발생했습니다.');
      } finally {
        if (requestId === historyRequestId.current) setIsLoading(false);
      }
    },
    [logout],
  );

  // 조회 조건·페이지·개수·시뮬레이션 데이터 토글이 바뀔 때마다 해당 페이지만 다시 받아온다.
  const runFetchHistory = useCallback(() => {
    void fetchHistory(query);
  }, [fetchHistory, query]);
  useRunWhenReady(isAuthorized, runFetchHistory);

  useEffect(() => {
    if (!isAuthorized) return;
    let cancelled = false;

    const fetchLocations = async () => {
      try {
        const session = getStoredAuthSession();
        if (!session?.token) return;
        const response = await fetch(`${API_BASE_URL}/rtls/live`, {
          method: 'GET',
          cache: 'no-store',
          headers: buildAuthHeaders(session.token),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok || cancelled) return;

        const readers = Array.isArray(payload.readers) ? (payload.readers as Array<{ location?: string | null }>) : [];
        const seen = new Set<string>();
        const values: Array<{ value: string; label: string }> = [];
        readers.forEach((reader) => {
          const value = (reader.location ?? '').trim();
          if (!value || seen.has(value)) return;
          seen.add(value);
          values.push({ value, label: value });
        });
        values.sort((left, right) => left.label.localeCompare(right.label, 'ko'));
        setLocationOptions(values);
      } catch {
        // 위치 목록은 부가 정보이므로 실패 시 조용히 무시한다.
      }
    };

    void fetchLocations();
    return () => {
      cancelled = true;
    };
  }, [isAuthorized]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setQuery((prev) => ({ ...prev, filters, page: 1 }));
  };

  const onReset = () => {
    setFilters(DEFAULT_FILTERS);
    setQuery((prev) => ({ ...prev, filters: DEFAULT_FILTERS, page: 1 }));
  };

  const downloadCsv = async () => {
    if (!total) return;

    // 화면은 한 페이지씩만 받지만 CSV는 조회 조건에 맞는 전체를 담는다.
    // 검증 결과 칸이 있어 온체인 검증까지 함께 받는다 — 청크당 스크립트 1회라 규모가 커도 호출 수는 늘지 않는다.
    // 사용 중인 이력은 검증 대상이 아니므로 화면 체크와 무관하게 항상 뺀다.
    const session = getStoredAuthSession();
    if (!session?.token) {
      logout();
      return;
    }

    const collected: UsageHistoryItem[] = [];
    // 화면 total은 사용 중인 이력까지 세므로, 받아야 할 건수는 CSV 첫 응답에서 다시 읽는다.
    let csvTotal = Number.POSITIVE_INFINITY;
    setCsvProgress({ received: 0, total: 0 });
    try {
      while (collected.length < csvTotal) {
        const params = buildHistoryParams(
          { ...query, page: 1, pageSize: CSV_CHUNK_SIZE, includeInUse: false },
          { includeBlockchain: true },
        );
        // 서버가 limit을 잘라도 어긋나지 않도록, 요청한 수가 아니라 이미 받은 수만큼 전진한다.
        params.set('offset', String(collected.length));
        const response = await fetch(`${API_BASE_URL}/usage/history?${params.toString()}`, {
          method: 'GET',
          cache: 'no-store',
          headers: buildAuthHeaders(session.token),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.detail ?? 'CSV로 내보낼 사용 이력을 불러오지 못했습니다.');
        }
        if (typeof payload.total === 'number') csvTotal = payload.total;
        const chunkItems = Array.isArray(payload.items) ? (payload.items as UsageHistoryItem[]) : [];
        if (!chunkItems.length) break;
        collected.push(...chunkItems);
        setCsvProgress({ received: collected.length, total: Number.isFinite(csvTotal) ? csvTotal : 0 });
      }
    } catch (err) {
      if (err instanceof Error) setError(err.message);
      else setError('CSV 내보내기 중 오류가 발생했습니다.');
      return;
    } finally {
      // 성공하든 실패하든 모달은 반드시 닫는다.
      setCsvProgress(null);
    }

    const header = [
      '사용 이력 ID',
      '장비명',
      '대여자 정보',
      '반납자 정보',
      '대여 위치',
      '반납 위치',
      '대여 시각',
      '반납 시각',
      '이동 경로',
      '무결성 검증 결과',
    ];

    const rows = collected.map((item) => [
      item.usage_id,
      item.equipment.name,
      formatHandler(item.user.name, getDisplayDepartment(item), getDisplayPosition(item)),
      formatHandler(item.returned_by.name, getDisplayReturnedByDepartment(item), getDisplayReturnedByPosition(item)),
      getLocationLabel(item.checkout.location, item.checkout.reader_id),
      getLocationLabel(item.return.location, item.return.reader_id),
      formatDateTime(item.checkout.at),
      formatDateTime(item.return.at),
      item.movement_path && item.movement_path.length > 0
        ? item.movement_path.map((point) => point.location).join(' → ')
        : '-',
      getCsvVerificationResult(item.blockchain?.verification_status),
    ]);

    const csv = [
      '\ufeff' + header.map(escapeCsvCell).join(','),
      ...rows.map((row) => row.map(escapeCsvCell).join(',')),
    ].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `usage_history_${formatDownloadTimestamp(new Date())}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // 검증 결과는 지금 화면에 띄운 페이지에 대해서만 계산된다(전수 검증은 비용이 커서 하지 않는다).
  const pageVerifiedCount = items.filter((item) => item.blockchain?.verification_status === 'verified').length;
  const pageIssueCount = items.filter((item) => {
    const status = item.blockchain?.verification_status ?? 'chain_error';
    return status !== 'verified' && status !== 'not_eligible';
  }).length;

  // 검색 조건 필드 + 액션 버튼 — 데스크탑 사이드바와 모바일 "상세검색" 펼침 영역에서 함께 쓴다.
  const renderSearchFields = () => (
    <>
      <div className="space-y-2">
        <label className="block text-sm font-medium">사용자</label>
        <Input
          type="text"
          value={filters.user}
          onChange={(e) => updateFilter('user', e.target.value)}
          placeholder="이름, 사용자 ID"
        />
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium">장비</label>
        <Input
          type="text"
          value={filters.equipment}
          onChange={(e) => updateFilter('equipment', e.target.value)}
          placeholder="장비명 또는 태그 ID"
        />
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium">대여 위치</label>
        <Select
          value={filters.checkoutLocation || 'all'}
          onValueChange={(value) => updateFilter('checkoutLocation', value === 'all' ? '' : value)}
        >
          <SelectTrigger>
            <SelectValue placeholder="대여 위치 선택" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 위치</SelectItem>
            {locationOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium">반납 위치</label>
        <Select
          value={filters.returnLocation || 'all'}
          onValueChange={(value) => updateFilter('returnLocation', value === 'all' ? '' : value)}
        >
          <SelectTrigger>
            <SelectValue placeholder="반납 위치 선택" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 위치</SelectItem>
            {locationOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium">조회 시작일</label>
        <Input
          type="date"
          value={filters.startDate}
          max={filters.endDate || undefined}
          onChange={(e) => updateStartDate(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium">조회 종료일</label>
        <Input
          type="date"
          value={filters.endDate}
          min={filters.startDate || undefined}
          onChange={(e) => updateEndDate(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium">정렬 기준</label>
        <Select value={filters.sortField} onValueChange={(value) => updateFilter('sortField', value as SortField)}>
          <SelectTrigger>
            <SelectValue placeholder="정렬 기준 선택" />
          </SelectTrigger>
          <SelectContent>
            {SORT_FIELD_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <label className="block text-sm font-medium">정렬 방향</label>
        <Select value={filters.sortOrder} onValueChange={(value) => updateFilter('sortOrder', value as SortOrder)}>
          <SelectTrigger>
            <SelectValue placeholder="정렬 방향 선택" />
          </SelectTrigger>
          <SelectContent>
            {SORT_ORDER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-4">
        <Button type="submit" disabled={isLoading}>
          {isLoading ? '조회 중...' : '조회'}
        </Button>
        <Button type="button" variant="outline" onClick={() => void fetchHistory(query)} disabled={isLoading}>
          새로고침
        </Button>
        <Button type="button" variant="outline" onClick={onReset}>
          초기화
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void downloadCsv()}
          disabled={isLoading || total === 0 || csvProgress !== null}
        >
          CSV 다운로드
        </Button>
      </div>
    </>
  );

  if (!isAuthorized) {
    return null;
  }

  return (
    <AppShell bleed actions={<AdminNav active="verification" />} contentClassName="pt-4 sm:pt-5">
      {/* 사이드바를 상하 꽉 채우기 위해, AppShell 공용 상하 패딩(contentClassName="pt-4 sm:pt-5" +
          .app-shell__content의 3.5rem 하단 패딩)을 이 행 전체에서 걷어내고, 사이드바가 아닌
          나머지(이력 목록) 쪽에만 그 패딩을 되돌려준다. */}
      {/* xl:items-start — 자식이 stretch로 늘어나면 사이드바의 sticky가 동작하지 않는다 */}
      <div className="-mt-4 -mb-14 flex w-full flex-col gap-4 sm:-mt-5 xl:flex-row xl:items-start">
        {isDesktop ? (
          <ResizableSidebar testId="verification-sidebar">
            <>
              <div className="panel-header shrink-0">
                <div>
                  <div className="panel-title">검색 조건</div>
                </div>
              </div>

              {/* 조건이 많아 사이드바를 넘치므로 필드는 스크롤시키되, 버튼 줄은 패널 하단에 고정하지 않고
                  마지막 필드 바로 아래에 이어 붙인다. */}
              <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">{renderSearchFields()}</div>
              </form>

              {error ? <div className="alert alert-error mt-4 shrink-0">{error}</div> : null}
            </>
          </ResizableSidebar>
        ) : (
          // 좁은 화면에서는 사이드바 박스 대신, 결과 목록 위에 "상세검색" 토글로 접힌 폼을 둔다.
          <div className="space-y-3 pt-6 pl-5 pr-3 sm:pt-5">
            <div className="panel-title">검색 조건</div>

            <button
              type="button"
              aria-expanded={advancedSearchOpen}
              onClick={() => setAdvancedSearchOpen((prev) => !prev)}
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground"
            >
              상세검색
              {advancedSearchOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>

            {advancedSearchOpen ? (
              <form onSubmit={onSubmit} className="space-y-3">
                {renderSearchFields()}
              </form>
            ) : null}

            {error ? <div className="alert alert-error">{error}</div> : null}
          </div>
        )}

        {/* 모바일에서는 이 섹션이 사이드바 없이 단독으로 좌측 벽에 붙어 있었다 — xl 미만에서만
            좌우 여백을 직접 주고, xl 이상(사이드바와 나란히 배치)에서는 기존 그대로 되돌린다. */}
        <div className="flex w-full min-w-0 flex-1 justify-center pt-4 pb-14 pl-5 pr-3 sm:pt-5 xl:pl-0 xl:pr-[clamp(1rem,2.5vw,2rem)]">
          <div className="w-full max-w-[1360px]">
            <section className="surface-panel p-5 fade-rise-delay">
              <div className="panel-header">
                <div>
                  <div className="panel-title">장비 사용 이력</div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={query.hideSimulated}
                      onChange={(event) =>
                        setQuery((prev) => ({ ...prev, hideSimulated: event.target.checked, page: 1 }))
                      }
                    />
                    시뮬레이션 데이터 숨기기
                  </label>
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={query.includeInUse}
                      onChange={(event) =>
                        setQuery((prev) => ({ ...prev, includeInUse: event.target.checked, page: 1 }))
                      }
                    />
                    사용 중인 이력 포함
                  </label>
                  <Badge variant="outline">이 페이지 검증 완료 {pageVerifiedCount}건</Badge>
                  <Badge variant="outline">검증 실패 {pageIssueCount}건</Badge>
                </div>
              </div>

              <div className="space-y-2.5">
                {isLoading ? (
                  <HistorySkeleton />
                ) : items.length === 0 ? (
                  <div className="empty-state">조회된 사용 이력이 없습니다.</div>
                ) : (
                  items.map((item) => (
                    <UsageHistoryRow key={item.usage_id} item={item} onOpen={() => setDetailUsageId(item.usage_id)} />
                  ))
                )}
              </div>

              {total > 0 ? (
                <Pagination
                  page={query.page}
                  pageSize={query.pageSize}
                  totalItems={total}
                  onPageChange={(nextPage) => setQuery((prev) => ({ ...prev, page: nextPage }))}
                  onPageSizeChange={(nextSize) => setQuery((prev) => ({ ...prev, pageSize: nextSize, page: 1 }))}
                />
              ) : null}
            </section>
          </div>
        </div>
      </div>

      <UsageDetailDialog
        item={items.find((item) => item.usage_id === detailUsageId) ?? null}
        onClose={() => setDetailUsageId(null)}
      />

      <CsvProgressDialog progress={csvProgress} />
    </AppShell>
  );
}
