import { useEffect, useState } from 'react';
import StaffShell from '../components/layout/StaffShell';
import { PillToggle } from '../components/layout/staffControls';
import { API_BASE_URL } from '../lib/runtime';
import { buildAuthHeaders, getStoredAuthSession, LOGIN_PATH } from '../lib/auth';
import { useAuthGuard, useLogout } from '../lib/useAuthGuard';
import {
  formatPercent,
  PERIOD_OPTIONS,
  recommendation,
  verdictLabel,
  type Heatmap,
  type HourlyProfile,
  type PeriodDays,
  type UtilizationResponse,
  type UtilizationType,
} from '../lib/utilization';

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

// 백엔드가 KST(+09:00) ISO 문자열을 주므로 날짜 부분을 그대로 읽는다 (브라우저 시간대와 무관)
function formatDate(iso: string) {
  return `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;
}

function formatPeriod({ start, end }: UtilizationResponse['period']) {
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
  return `${formatDate(start)} ~ ${formatDate(end)} · ${days}일`;
}

function useUtilization(days: PeriodDays, enabled: boolean) {
  const [data, setData] = useState<UtilizationResponse | null>(null);
  const [error, setError] = useState('');
  const logout = useLogout();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const load = async () => {
      try {
        const session = getStoredAuthSession();
        if (!session?.token) {
          logout();
          return;
        }
        const response = await fetch(`${API_BASE_URL}/admin/utilization?days=${days}`, {
          method: 'GET',
          cache: 'no-store',
          headers: buildAuthHeaders(session.token),
        });
        const payload = await response.json().catch(() => null);
        if (response.status === 401 || response.status === 403) {
          logout();
          return;
        }
        if (!response.ok || !payload?.ok || !Array.isArray(payload.types)) {
          throw new Error(payload?.detail ?? '가동률을 가져오지 못했습니다.');
        }
        if (cancelled) return;
        setData(payload);
        setError('');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '가동률 조회 중 오류가 발생했습니다.');
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [days, enabled, logout]);

  return { data, error };
}

function VerdictMark({ item }: { item: UtilizationType }) {
  return (
    <span className="staff-util-mark">
      <span className={`staff-util-dot staff-util-dot--${item.verdict}`} aria-hidden="true" />
      {verdictLabel(item.verdict)}
    </span>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <span className="staff-util-bar" aria-hidden="true">
      <span style={{ width: `${Math.min(100, value * 100)}%` }} />
    </span>
  );
}

// 칸 농도는 이 히트맵의 최댓값을 가장 진하게 하는 상대 스케일
function HeatmapGrid({ grid }: { grid: Heatmap }) {
  const max = Math.max(0, ...grid.flat());
  return (
    <div className="staff-util-heat">
      <div className="staff-util-heat__scroll">
        <div
          className="staff-util-heat__grid"
          role="img"
          aria-label={`요일·시간대별 가동률, 최대 ${formatPercent(max)}`}
        >
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className="staff-util-heat__hour">
              {hour % 3 === 0 ? hour : ''}
            </span>
          ))}
          {grid.map((row, day) => (
            <div key={day} className="contents">
              <span className="staff-util-heat__day">{WEEKDAYS[day]}</span>
              {row.map((value, hour) => (
                <span
                  key={hour}
                  className="staff-util-heat__cell"
                  title={`${WEEKDAYS[day]} ${hour}시 · ${formatPercent(value)}`}
                  style={
                    value > 0 && max > 0
                      ? {
                          background: `color-mix(in srgb, var(--staff-teal) ${Math.round((value / max) * 100)}%, var(--staff-fill))`,
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="staff-util-heat__legend staff-note">
        <span>0%</span>
        <span className="staff-util-heat__ramp" aria-hidden="true" />
        <span>{formatPercent(max)}</span>
      </div>
    </div>
  );
}

// 평일·주말 시간대 가동률 선 그래프. 세로축은 두 선의 최댓값을 10% 단위로 올린 값까지
function HourlyLines({ profile }: { profile: HourlyProfile }) {
  const series = [
    { key: 'weekday', label: '평일(월~금)', values: profile.weekday },
    { key: 'weekend', label: '주말(토·일)', values: profile.weekend },
  ] as const;
  const highest = Math.max(0, ...profile.weekday, ...profile.weekend);
  const top = Math.max(0.1, Math.ceil(highest * 10 - 1e-9) / 10);
  const steps = Math.round(top * 10);
  const ticks = Array.from({ length: steps + 1 }, (_, i) => i / 10).filter((_, i) => steps <= 5 || i % 2 === 0);
  const y = (value: number) => `${(value / top) * 100}%`;
  // 점은 시간 칸(24등분)의 가운데 — 눈금 글자·마우스 영역과 같은 자리
  const points = (values: readonly number[]) =>
    values.map((value, hour) => `${((hour + 0.5) / 24) * 1000},${300 - (value / top) * 300}`).join(' ');
  const peakText = (values: readonly number[]) => {
    const peak = Math.max(...values);
    return peak > 0 ? `${values.indexOf(peak)}시 ${formatPercent(peak)}` : '대여 없음';
  };

  return (
    <div className="staff-util-chart">
      <div className="staff-util-legend">
        {series.map((item) => (
          <span key={item.key}>
            <i className={`staff-util-key staff-util-key--${item.key}`} aria-hidden="true" />
            {item.label}
          </span>
        ))}
      </div>
      <div
        className="staff-util-lines"
        role="img"
        aria-label={`시간대별 가동률 그래프. 평일 최고 ${peakText(profile.weekday)}, 주말 최고 ${peakText(profile.weekend)}`}
      >
        <div className="staff-util-lines__axis" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick} style={{ bottom: y(tick) }}>
              {formatPercent(tick)}
            </span>
          ))}
        </div>
        <div className="staff-util-lines__plot">
          {ticks.slice(1).map((tick) => (
            <span key={tick} className="staff-util-lines__grid" style={{ bottom: y(tick) }} />
          ))}
          <svg viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
            {series.map((item) => (
              <polyline
                key={item.key}
                className={`staff-util-line staff-util-line--${item.key}`}
                points={points(item.values)}
              />
            ))}
          </svg>
          <div className="staff-util-lines__hits">
            {profile.weekday.map((weekday, hour) => (
              <span
                key={hour}
                title={`${hour}시 · 평일 ${formatPercent(weekday)} · 주말 ${formatPercent(profile.weekend[hour])}`}
              />
            ))}
          </div>
        </div>
        <div className="staff-util-lines__x" aria-hidden="true">
          {profile.weekday.map((_, hour) => (
            <span key={hour}>{hour % 3 === 0 ? `${hour}시` : ''}</span>
          ))}
        </div>
      </div>
      <p className="staff-note mt-3">판정은 모든 요일을 합친 시간대 가동률 기준입니다.</p>
    </div>
  );
}

function Summary({ data }: { data: UtilizationResponse }) {
  const metrics = [
    { label: '전체 가동률', value: formatPercent(data.summary.utilization) },
    { label: '추가 구매 검토', value: `${data.summary.shortage_type_count}종` },
    { label: '유휴', value: `${data.summary.idle_type_count}종` },
  ];
  return (
    <dl className="staff-util-summary" data-testid="utilization-summary">
      {metrics.map((metric) => (
        <div key={metric.label}>
          <dt className="staff-note">{metric.label}</dt>
          <dd>{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TypeList({
  data,
  selected,
  onSelect,
}: {
  data: UtilizationResponse;
  selected: UtilizationType | null;
  onSelect: (type: string | null) => void;
}) {
  const totalUnits = data.types.reduce((sum, item) => sum + item.unit_count, 0);
  return (
    <section className="staff-panel">
      <div className="staff-util-list" role="group" aria-label="장비 종류">
        <button
          type="button"
          aria-pressed={selected === null}
          className={selected === null ? 'staff-util-row staff-util-row--on' : 'staff-util-row'}
          onClick={() => onSelect(null)}
        >
          <span className="staff-util-row__name">
            <span>전체 장비</span>
            <span className="staff-note">{totalUnits}대</span>
          </span>
          <span className="staff-util-row__bar">
            <Bar value={data.summary.utilization} />
            <span>{formatPercent(data.summary.utilization)}</span>
          </span>
          <span />
        </button>
        {data.types.map((item) => (
          <button
            key={item.equipment_type}
            type="button"
            aria-pressed={selected === item}
            className={selected === item ? 'staff-util-row staff-util-row--on' : 'staff-util-row'}
            onClick={() => onSelect(item.equipment_type)}
          >
            <span className="staff-util-row__name">
              <span>{item.equipment_type}</span>
              <span className="staff-note">{item.unit_count}대</span>
            </span>
            <span className="staff-util-row__bar">
              <Bar value={item.utilization} />
              <span>{formatPercent(item.utilization)}</span>
            </span>
            <VerdictMark item={item} />
          </button>
        ))}
      </div>
    </section>
  );
}

type ChartForm = 'lines' | 'heatmap';

function Detail({ data, item }: { data: UtilizationResponse; item: UtilizationType | null }) {
  // 장비 검색의 2D/3D처럼 화면마다 그래프로 시작하고 고른 값은 기억하지 않는다
  const [chart, setChart] = useState<ChartForm>('lines');
  const totalUnits = data.types.reduce((sum, type) => sum + type.unit_count, 0);
  const sentence = item
    ? (recommendation(item) ?? `가장 바쁜 ${item.peak_hour}시대 ${formatPercent(item.peak_utilization)}`)
    : null;
  return (
    <div className="staff-util-detail">
      <section className="staff-panel" aria-label="선택한 장비 상세">
        <div className="staff-panel__head">
          <h2 className="staff-panel__title">{item ? item.equipment_type : '전체 장비'}</h2>
          {item ? <VerdictMark item={item} /> : null}
        </div>
        <p className="staff-note">
          {item
            ? `${item.unit_count}대 · 가동률 ${formatPercent(item.utilization)} · 대여 ${item.checkout_count}회`
            : `${totalUnits}대 · 가동률 ${formatPercent(data.summary.utilization)}`}
        </p>
        {sentence ? <p className="staff-util-detail__sentence">{sentence}</p> : null}
        <div className="staff-util-chartbar">
          <PillToggle
            small
            label="그래프 형태"
            value={chart}
            options={[
              { value: 'lines', label: '그래프' },
              { value: 'heatmap', label: '히트맵' },
            ]}
            onChange={setChart}
          />
        </div>
        {chart === 'lines' ? (
          <HourlyLines
            profile={item ? (data.hourly.by_type[item.equipment_type] ?? data.hourly.all) : data.hourly.all}
          />
        ) : (
          <HeatmapGrid
            grid={item ? (data.heatmap.by_type[item.equipment_type] ?? data.heatmap.all) : data.heatmap.all}
          />
        )}
      </section>
      {item ? (
        <section className="staff-panel">
          <h2 className="staff-panel__title">장비별</h2>
          <ul className="staff-util-units" aria-label="장비별 가동률">
            {item.units.map((unit) => (
              <li key={unit.tag_id}>
                <span>{unit.equipment_name}</span>
                <Bar value={unit.utilization} />
                <span className="tabular-nums">{formatPercent(unit.utilization)}</span>
                <span className="staff-note tabular-nums">
                  {unit.checkout_count === 0 ? '미사용' : `대여 ${unit.checkout_count}회`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default function EquipmentUtilization() {
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
  const [days, setDays] = useState<PeriodDays>(30);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const { data, error } = useUtilization(days, isAuthorized);

  if (!isAuthorized) return null;

  const empty = !!data && data.types.every((item) => item.checkout_count === 0);
  const selected = data?.types.find((item) => item.equipment_type === selectedType) ?? null;

  return (
    <StaffShell menu="admin" current="utilization">
      <div className="staff-work staff-work__content">
        <header className="staff-work__heading">
          <div>
            <div className="staff-util-title">
              <h1 className="staff-title">가동률 분석</h1>
              {data ? <Summary data={data} /> : null}
            </div>
            <p className="staff-note mt-2">{data ? formatPeriod(data.period) : ' '}</p>
          </div>
          <PillToggle
            label="분석 기간"
            value={String(days)}
            options={PERIOD_OPTIONS.map((option) => ({ value: String(option), label: `${option}일` }))}
            onChange={(value) => setDays(Number(value) as PeriodDays)}
          />
        </header>
        {error ? (
          <div className="staff-alert" role="alert">
            {error}
          </div>
        ) : null}
        {/* 기간을 바꾸는 동안에는 이전 결과를 그대로 둔다 */}
        {!data && !error ? <div className="staff-empty-block">불러오는 중입니다.</div> : null}
        {data && empty ? <div className="staff-empty-block">이 기간에는 사용 기록이 없습니다.</div> : null}
        {data && !empty ? (
          <div className="staff-util-split">
            <TypeList data={data} selected={selected} onSelect={setSelectedType} />
            <Detail data={data} item={selected} />
          </div>
        ) : null}
      </div>
    </StaffShell>
  );
}
