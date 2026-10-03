import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import AppShell from '../components/layout/AppShell';
import StaffNav from '../components/layout/StaffNav';
import FloorMapView, {
  type FloorMapPin,
  type FloorMapEquipmentDot,
  type FloorMapHighlight,
} from '../components/FloorMapView';
import { FLOOR_MAPS, type FloorNumber } from '../lib/floorMaps';
import { getAmenityZonesForFloor } from '../lib/floorZones';
import { ZONE_BOUNDS } from '../lib/floorZoneBounds';
import { polygonCentroid } from '../lib/floorMapLayout';
import ResizableSidebar from '../components/layout/ResizableSidebar';
import { formatIBeaconTag } from '../lib/iBeaconTag';
import { API_BASE_URL } from '../lib/runtime';
import { buildAuthHeaders, getStoredAuthSession, LOGIN_PATH } from '../lib/auth';
import { useAuthGuard, useLogout } from '../lib/useAuthGuard';
import { useMediaQuery } from '../lib/useMediaQuery';

// 사이드바가 지도 옆에 나란히 붙는 시점(xl) — 그 미만에서는 사이드바 대신
// 가로 스크롤 필터 바 + 결과 목록 다이얼로그를 쓴다.
const DESKTOP_QUERY = '(min-width: 1280px)';

type LiveLocationItem = {
  tag_id: string;
  equipment_name: string | null;
  equipment_type: string | null;
  asset_status: string;
  current_holder_user_id: number | null;
  current_holder_name: string | null;
  reader_id: string | null;
  location: string | null;
  rssi: number | null;
  updated_at: number | null;
  is_stale: boolean;
  is_online: boolean;
  last_seen: number | null;
};

type LiveReaderItem = {
  reader_id: string;
  location: string;
  is_online: boolean;
  last_seen: number | null;
  floor: number | null;
  // 시뮬레이션 숨기기를 요청했을 때만 서버가 실어준다.
  is_real_hardware?: boolean;
};

// "층별 구역 안내" 패널 한 줄. 리더가 있는 구역은 클릭 시 장비 목록도 필터링되지만,
// 리더 없는 편의시설 구역(floorZones.ts)은 필터링할 장비가 없어 지도 강조만 한다.
type ZoneGuideRow = {
  id: string;
  name: string;
  hasReader: boolean;
  mapX: number | null;
  mapY: number | null;
  equipmentCount: number;
};

type EquipmentViewItem = {
  id: string;
  name: string;
  type: string;
  location: string;
  readerId: string;
  updatedAt: number | null;
  isStale: boolean;
  isOnline: boolean;
  lastSeen: number | null;
  assetStatus: string;
  currentHolderUserId: number | null;
  currentHolderName: string | null;
};

function getOnlineDotClass(isOnline: boolean) {
  return isOnline ? 'h-2.5 w-2.5 rounded-full dot-ok' : 'h-2.5 w-2.5 rounded-full dot-warn';
}

function getAssetStatusColor(status: string) {
  switch (status) {
    case 'checked_out':
      return 'h-2.5 w-2.5 rounded-full dot-err';
    case 'inactive':
      return 'h-2.5 w-2.5 rounded-full solid-neutral';
    default:
      return 'h-2.5 w-2.5 rounded-full dot-ok';
  }
}

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

// 위치 미확인(오프라인) 태그의 표시용 라벨. 좌측 "장비 목록"에는 그대로 노출되어야 하지만,
// 우측 위치 패널 그리드·위치 필터 드롭다운에는 실제 위치가 아니므로 절대 새어 들어가면 안 된다.
const UNLOCATED_LABEL = '감지 안 됨';

export default function EquipmentSearch() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState('전체');
  const [selectedLocation, setSelectedLocation] = useState('전체');
  const [selectedListFloor, setSelectedListFloor] = useState<FloorNumber | '전체'>('전체');
  const [selectedEquipment, setSelectedEquipment] = useState<string | null>(null);
  // 직원이 가장 먼저 보고 싶은 건 "장비가 지금 어디 있나"라서 지도를 기본으로 연다.
  const [viewMode, setViewMode] = useState<'list' | 'map'>('map');
  const [selectedFloor, setSelectedFloor] = useState<FloorNumber>(1);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [hideSimulated, setHideSimulated] = useState(false);
  const [highlightedZone, setHighlightedZone] = useState<FloorMapHighlight | null>(null);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [advancedSearchOpen, setAdvancedSearchOpen] = useState(false);
  const isAuthorized = useAuthGuard(() => {
    try {
      const session = getStoredAuthSession();
      if (!session?.token || !session.user) return LOGIN_PATH;
      if (session.user.role === 'admin') return '/verification';
      if (session.user.role !== 'staff') return LOGIN_PATH;
      return null;
    } catch {
      return LOGIN_PATH;
    }
  });

  const [liveItems, setLiveItems] = useState<LiveLocationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [readers, setReaders] = useState<LiveReaderItem[]>([]);

  const logout = useLogout();

  const equipment = useMemo<EquipmentViewItem[]>(() => {
    return liveItems.map((item) => ({
      id: item.tag_id,
      name: item.equipment_name?.trim() || item.tag_id,
      type: item.equipment_type?.trim() || '미분류',
      location: item.location ?? UNLOCATED_LABEL,
      readerId: item.reader_id ?? '-',
      updatedAt: item.updated_at,
      isStale: item.is_stale,
      isOnline: item.is_online,
      lastSeen: item.last_seen,
      assetStatus: item.asset_status,
      currentHolderUserId: item.current_holder_user_id,
      currentHolderName: item.current_holder_name,
    }));
  }, [liveItems]);

  const equipmentTypes = useMemo(() => {
    const set = new Set(equipment.map((e) => e.type));
    return ['전체', ...Array.from(set)];
  }, [equipment]);

  const readerLocations = useMemo(
    () =>
      Array.from(
        new Set(
          readers
            .filter((reader) => selectedListFloor === '전체' || reader.floor === selectedListFloor)
            .map((reader) => reader.location)
            .filter((location) => location.length > 0 && location !== UNLOCATED_LABEL),
        ),
      ),
    [readers, selectedListFloor],
  );

  const readerFloorById = useMemo(() => new Map(readers.map((r) => [r.reader_id, r.floor])), [readers]);

  // 시뮬레이션 숨기기를 켰을 때만 서버가 리더의 실물 여부를 함께 준다.
  // 그 값으로 현재 층에서 실제 하드웨어가 놓인 구역만 밝게 남긴다(나머지는 지도에서 어두워짐).
  const realReaderIdsOnFloor = useMemo(() => {
    if (!hideSimulated) return null;
    return readers.filter((r) => r.floor === selectedFloor && r.is_real_hardware === true).map((r) => r.reader_id);
  }, [hideSimulated, readers, selectedFloor]);

  const realHardwareFloors = useMemo(
    () =>
      Array.from(
        new Set(readers.filter((r) => r.is_real_hardware === true && r.floor != null).map((r) => r.floor as number)),
      ).sort((left, right) => left - right),
    [readers],
  );

  // 실물 리더가 없는 층에 머물면 지도가 통째로 어두워지기만 한다 — 실제로 있는 층으로 옮겨준다.
  useEffect(() => {
    if (!hideSimulated) return;
    if (realHardwareFloors.length === 0) return;
    if (realHardwareFloors.includes(selectedFloor)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedFloor(realHardwareFloors[0] as FloorNumber);
  }, [hideSimulated, realHardwareFloors, selectedFloor]);

  // 장비가 아직 하나도 위치하지 않은 활성 리더 구역도 필터·패널에 노출되도록 리더 로스터를 합친다.
  const locations = useMemo(() => {
    const set = new Set([
      ...equipment
        .filter((e) => e.location !== UNLOCATED_LABEL)
        .filter((e) => selectedListFloor === '전체' || readerFloorById.get(e.readerId) === selectedListFloor)
        .map((e) => e.location),
      ...readerLocations,
    ]);
    return ['전체', ...Array.from(set)];
  }, [equipment, readerLocations, selectedListFloor, readerFloorById]);

  // 목록 뷰 구역 카드는 층 탭(selectedFloor)만 따른다 — 사이드바 층 Select와는 무관하다.
  // 장비가 아직 하나도 없는 구역도 리더 로스터에서 끌어와 카드를 띄운다.
  const locationPanels = useMemo(() => {
    const set = new Set([
      ...equipment
        .filter((e) => e.location !== UNLOCATED_LABEL)
        .filter((e) => readerFloorById.get(e.readerId) === selectedFloor)
        .map((e) => e.location),
      ...readers
        .filter((r) => r.floor === selectedFloor)
        .map((r) => r.location)
        .filter((location) => location.length > 0 && location !== UNLOCATED_LABEL),
    ]);
    return Array.from(set);
  }, [equipment, readers, readerFloorById, selectedFloor]);

  // 검색어·종류·대여 여부 필터만 반영한 목록. 리더 위치 패널과 지도는 위치 필터와
  // 무관하게 항상 이 목록을 사용한다.
  const searchAndTypeFilteredEquipment = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return equipment.filter((item) => {
      const matchesSearch =
        q.length === 0 ||
        item.name.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q) ||
        item.location.toLowerCase().includes(q);

      const matchesType = selectedType === '전체' || item.type === selectedType;
      const matchesAvailability = !availableOnly || item.assetStatus === 'available';
      return matchesSearch && matchesType && matchesAvailability;
    });
  }, [equipment, searchQuery, selectedType, availableOnly]);

  const filteredEquipment = useMemo(() => {
    return searchAndTypeFilteredEquipment.filter(
      (item) =>
        (selectedLocation === '전체' || item.location === selectedLocation) &&
        (selectedListFloor === '전체' || readerFloorById.get(item.readerId) === selectedListFloor),
    );
  }, [searchAndTypeFilteredEquipment, selectedLocation, selectedListFloor, readerFloorById]);

  // 목록이 전체인지 검색 결과인지 알 수 있게, 지금 걸린 조건을 사람이 읽을 라벨로 모은다.
  const activeFilterLabels = useMemo(() => {
    const labels: string[] = [];
    const q = searchQuery.trim();
    if (q.length > 0) labels.push(`"${q}"`);
    if (selectedType !== '전체') labels.push(selectedType);
    if (selectedListFloor !== '전체') labels.push(`${selectedListFloor}층`);
    if (selectedLocation !== '전체') labels.push(selectedLocation);
    if (availableOnly) labels.push('사용 가능만');
    if (hideSimulated) labels.push('시뮬레이션 제외');
    return labels;
  }, [searchQuery, selectedType, selectedListFloor, selectedLocation, availableOnly, hideSimulated]);

  // 지도 탭: 선택된 층에 좌표가 배치된 리더만 핀으로 그리고, 그 리더에 속한 장비를 점으로 흩뿌린다.
  const floorPins = useMemo<FloorMapPin[]>(
    () => readers.filter((r) => r.floor === selectedFloor).map((r) => ({ reader_id: r.reader_id, label: r.location })),
    [readers, selectedFloor],
  );

  const floorEquipmentDots = useMemo<FloorMapEquipmentDot[]>(() => {
    const pinReaderIds = new Set(floorPins.map((p) => p.reader_id));
    return searchAndTypeFilteredEquipment
      .filter((eq) => pinReaderIds.has(eq.readerId))
      .map((eq) => ({ tag_id: eq.id, reader_id: eq.readerId, label: eq.name, assetStatus: eq.assetStatus }));
  }, [floorPins, searchAndTypeFilteredEquipment]);

  // "층별 구역 안내": 선택된 층의 리더 구역(장비 추적 가능)과 편의시설 구역(floorZones.ts,
  // 리더 없음)을 합쳐서 보여준다. 병원 홈페이지 안내도에 실린 구역은 BLE 추적 여부와
  // 무관하게 전부 노출한다.
  const zoneGuideRows = useMemo<ZoneGuideRow[]>(() => {
    const readerRows: ZoneGuideRow[] = readers
      .filter((r) => r.floor === selectedFloor)
      .map((r) => {
        const polygon = ZONE_BOUNDS[r.reader_id];
        const centroid = polygon ? polygonCentroid(polygon) : null;
        return {
          id: r.reader_id,
          name: r.location,
          hasReader: true,
          mapX: centroid ? centroid.x : null,
          mapY: centroid ? centroid.y : null,
          equipmentCount: searchAndTypeFilteredEquipment.filter((eq) => eq.readerId === r.reader_id).length,
        };
      });
    const amenityRows: ZoneGuideRow[] = getAmenityZonesForFloor(selectedFloor).map((zone) => ({
      id: zone.id,
      name: zone.name,
      hasReader: false,
      mapX: zone.mapX,
      mapY: zone.mapY,
      equipmentCount: 0,
    }));
    return [...readerRows, ...amenityRows];
  }, [readers, selectedFloor, searchAndTypeFilteredEquipment]);

  // 지도 뷰와 목록 뷰가 같은 층 탭을 쓴다 — 뷰를 오가도 보고 있던 층이 유지된다.
  const floorTabs = (
    <div data-testid="floor-tabs" className="flex gap-2">
      {FLOOR_MAPS.map((f) => (
        <button
          key={f.floor}
          type="button"
          className={f.floor === selectedFloor ? 'app-nav-tab app-nav-tab--active' : 'app-nav-tab'}
          onClick={() => {
            setSelectedFloor(f.floor);
            setHighlightedZone(null);
            setSelectedEquipment(null);
          }}
        >
          {f.label}
        </button>
      ))}
    </div>
  );

  // 같은 장비를 다시 고르면 강조를 끈다 — 지도에서 계속 깜빡이는 점이 남지 않게.
  const toggleSelectedEquipment = (tagId: string) => {
    setSelectedEquipment((prev) => (prev === tagId ? null : tagId));
  };

  // 검색/필터 필드들 — 데스크탑 사이드바(세로 목록)와 모바일 가로 스크롤 바에서 함께 쓴다.
  // compact=true면 라벨을 없애고 스크롤 바 안에서 줄어들지 않는 폭을 준다.
  const typeFilterField = (compact: boolean) => (
    <div className={compact ? 'w-36 shrink-0 space-y-1' : 'space-y-2'}>
      <label className={compact ? 'text-xs text-muted-foreground' : 'text-base font-medium'}>장비 유형</label>
      <Select value={selectedType} onValueChange={setSelectedType}>
        <SelectTrigger>
          <SelectValue placeholder="유형 선택" />
        </SelectTrigger>
        <SelectContent>
          {equipmentTypes.map((type) => (
            <SelectItem key={type} value={type}>
              {type}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const floorFilterField = (compact: boolean) => (
    <div className={compact ? 'w-28 shrink-0 space-y-1' : 'space-y-2'}>
      <label className={compact ? 'text-xs text-muted-foreground' : 'text-base font-medium'}>층</label>
      <Select
        value={String(selectedListFloor)}
        onValueChange={(value) => setSelectedListFloor(value === '전체' ? '전체' : (Number(value) as FloorNumber))}
      >
        <SelectTrigger aria-label="층">
          <SelectValue placeholder="층 선택" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="전체">전체</SelectItem>
          {FLOOR_MAPS.map((f) => (
            <SelectItem key={f.floor} value={String(f.floor)}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const locationFilterField = (compact: boolean) => (
    <div className={compact ? 'w-36 shrink-0 space-y-1' : 'space-y-2'}>
      <label className={compact ? 'text-xs text-muted-foreground' : 'text-base font-medium'}>위치 필터</label>
      <Select value={selectedLocation} onValueChange={setSelectedLocation}>
        <SelectTrigger aria-label="위치">
          <SelectValue placeholder="위치 선택" />
        </SelectTrigger>
        <SelectContent>
          {locations.map((location) => (
            <SelectItem key={location} value={location}>
              {location}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  // 두 토글은 짝이라 한 줄에 둔다 — 폭이 좁으면 자동으로 줄바꿈된다.
  const toggleFilters = () => (
    <div data-testid="equipment-filter-toggles" className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <label className="flex items-center gap-2 text-base font-medium">
        <input type="checkbox" checked={availableOnly} onChange={(event) => setAvailableOnly(event.target.checked)} />
        사용 가능 장비만 보기
      </label>

      <label className="flex items-center gap-2 text-base font-medium">
        <input type="checkbox" checked={hideSimulated} onChange={(event) => setHideSimulated(event.target.checked)} />
        시뮬레이션 장비 숨기기
      </label>
    </div>
  );

  // 필터링된 장비 목록 항목들 — 데스크탑 사이드바에서는 그대로, 모바일 결과 다이얼로그에서는
  // 항목을 고르면 다이얼로그를 닫도록 afterSelect를 넘긴다.
  const resultsListItems = (afterSelect?: () => void) => {
    if (isLoading) {
      return <div className="empty-state">실시간 데이터 로딩 중입니다.</div>;
    }
    if (filteredEquipment.length === 0) {
      return <div className="empty-state">표시할 실시간 태그가 없습니다.</div>;
    }
    return filteredEquipment.map((item) => (
      <button
        key={item.id}
        type="button"
        onClick={() => {
          toggleSelectedEquipment(item.id);
          afterSelect?.();
        }}
        title={item.id}
        className={`w-full border-b border-border px-3 py-2 text-left transition-all last:border-b-0 ${
          selectedEquipment === item.id
            ? 'border-l-2 border-l-foreground bg-secondary'
            : 'border-l-2 border-l-transparent hover:bg-secondary'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[1.05rem] leading-tight">{item.name}</span>
          <span className={`shrink-0 ${getAssetStatusColor(item.assetStatus)}`} />
        </div>
        <div className="truncate text-sm text-muted-foreground">
          {item.location}
          {item.currentHolderName ? ` · ${item.currentHolderName}` : ''}
        </div>
      </button>
    ));
  };

  const handleZoneGuideClick = (zone: ZoneGuideRow) => {
    setViewMode('map');
    // 이미 강조 중인 구역을 다시 누르면 해제한다 — 켤 때 같이 걸었던 위치 필터도 함께 푼다.
    if (highlightedZone?.id === zone.id) {
      setHighlightedZone(null);
      if (zone.hasReader) setSelectedLocation('전체');
      return;
    }
    if (zone.hasReader) {
      setSelectedLocation(zone.name);
    }
    if (zone.mapX !== null && zone.mapY !== null) {
      setHighlightedZone({ id: zone.id, label: zone.name, mapX: zone.mapX, mapY: zone.mapY });
    }
  };

  useEffect(() => {
    if (!isAuthorized) return;
    let cancelled = false;
    let pollTimer: number | undefined;
    let requestController: AbortController | undefined;

    const fetchLiveLocations = async () => {
      const controller = new AbortController();
      requestController = controller;
      const requestTimeout = window.setTimeout(() => controller.abort(), 5000);
      try {
        const session = getStoredAuthSession();
        if (!session?.token) {
          logout();
          return;
        }
        // 시뮬레이션 장비 제외는 서버가 처리한다 — 직원 응답에는 항목별 실물 여부가 실리지 않는다.
        const query = hideSimulated ? '?hide_simulated=true' : '';
        const response = await fetch(`${API_BASE_URL}/rtls/live${query}`, {
          method: 'GET',
          cache: 'no-store',
          headers: buildAuthHeaders(session.token),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.status === 401 || response.status === 403) {
          logout();
          return;
        }
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.detail ?? '실시간 위치 데이터를 가져오지 못했습니다.');
        }

        if (cancelled) return;
        const serverItems = Array.isArray(payload.items) ? (payload.items as LiveLocationItem[]) : [];
        const serverReaders = Array.isArray(payload.readers) ? (payload.readers as LiveReaderItem[]) : [];
        setLiveItems(serverItems);
        setReaders(serverReaders);
        setFetchError('');
      } catch (err) {
        if (cancelled) return;
        setLiveItems([]);
        setReaders([]);
        if (err instanceof Error) setFetchError(err.message);
        else setFetchError('실시간 위치 조회 중 오류가 발생했습니다.');
      } finally {
        window.clearTimeout(requestTimeout);
        requestController = undefined;
        if (!cancelled) {
          setIsLoading(false);
          pollTimer = window.setTimeout(fetchLiveLocations, 1000);
        }
      }
    };

    void fetchLiveLocations();
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
      requestController?.abort();
    };
  }, [isAuthorized, logout, hideSimulated]);

  useEffect(() => {
    if (!selectedEquipment) return;
    if (!equipment.some((item) => item.id === selectedEquipment)) {
      // 실시간 폴링으로 태그가 목록에서 완전히 사라졌을 때 선택을 해제한다 (외부 데이터 변화에 대한 정당한 반응).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedEquipment(null);
    }
  }, [equipment, selectedEquipment]);

  // 목록에서 다른 층 장비를 고르면 지도도 그 층으로 따라간다 — 안 그러면 선택해도
  // 지도에 아무 반응이 없다.
  useEffect(() => {
    if (!selectedEquipment) return;
    const picked = equipment.find((item) => item.id === selectedEquipment);
    if (!picked) return;
    const floor = readerFloorById.get(picked.readerId);
    if (floor && floor !== selectedFloor) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedFloor(floor as FloorNumber);
    }
  }, [selectedEquipment, equipment, readerFloorById, selectedFloor]);

  useEffect(() => {
    if (selectedLocation === '전체') return;
    if (!locations.includes(selectedLocation)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedLocation('전체');
    }
  }, [locations, selectedLocation]);

  if (!isAuthorized) {
    return null;
  }

  return (
    <AppShell bleed actions={<StaffNav active="equipment" />} contentClassName="pt-4 sm:pt-5">
      {/* 사이드바를 상하 꽉 채우기 위해, AppShell 공용 상하 패딩(contentClassName="pt-4 sm:pt-5" +
          .app-shell__content의 3.5rem 하단 패딩)을 이 행 전체에서 걷어내고, 사이드바가 아닌
          나머지(지도+상세/구역안내) 쪽에만 그 패딩을 되돌려준다. */}
      {/* xl:items-start — 자식이 stretch로 늘어나면 사이드바의 sticky가 동작하지 않는다 */}
      <div className="-mt-4 -mb-14 flex w-full flex-col gap-4 sm:-mt-5 xl:flex-row xl:items-start">
        {isDesktop ? (
          <ResizableSidebar testId="equipment-sidebar">
            <>
              <div className="panel-header shrink-0">
                <div>
                  <div className="panel-title">장비 위치 검색</div>
                </div>
                <Badge variant="outline">추적 중 {equipment.length}개</Badge>
              </div>
              <div className="shrink-0 space-y-3">
                <Input
                  placeholder="태그 ID, 장비명, 위치 검색"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />

                {typeFilterField(false)}
                {floorFilterField(false)}
                {locationFilterField(false)}
                {toggleFilters()}

                {fetchError ? <div className="alert alert-error">{fetchError}</div> : null}
              </div>

              <div data-testid="equipment-result-summary" className="mt-4 shrink-0 border-t border-border pt-3">
                <div className="text-base font-medium">
                  {activeFilterLabels.length > 0 ? '검색 결과' : '전체'} {filteredEquipment.length}건
                </div>
                {activeFilterLabels.length > 0 ? (
                  <div className="mt-0.5 text-sm text-muted-foreground">{activeFilterLabels.join(' · ')}</div>
                ) : null}
              </div>

              <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto">{resultsListItems()}</div>
            </>
          </ResizableSidebar>
        ) : (
          // 좁은 화면에서는 사이드바 박스 대신, 지도 바로 위에 검색바 + 가로 스크롤 필터를
          // 얹고 결과 목록은 다이얼로그로 뗀다 — 세로로 쌓이는 박스 하나가 더 늘어나는 느낌을 피한다.
          // bleed 레이아웃이라 페이지 기본 좌우 여백이 없다 — 지도 쪽과 같은 clamp로 직접 줬었는데,
          // 모바일 루트 폰트(14px)와 좁은 vw에서 clamp 하한(14px)에 붙어 거의 안 보여서 고정값으로 바꿨다.
          // 이 행 전체는 사이드바 sticky 정렬을 위해 -mt-4로 상단 패딩이 이미 상쇄돼 있어
          // (아래 지도 섹션이 pt-4로 되돌리는 것과 동일하게) 여기서도 직접 되돌려야 한다.
          <div className="space-y-3 pt-6 pl-5 pr-3 sm:pt-5">
            <div className="flex items-center justify-between gap-2">
              <div className="panel-title">장비 위치 검색</div>
              <Badge variant="outline">추적 중 {equipment.length}개</Badge>
            </div>

            <Input
              placeholder="태그 ID, 장비명, 위치 검색"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

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
              <>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {typeFilterField(true)}
                  {floorFilterField(true)}
                  {locationFilterField(true)}
                </div>

                {toggleFilters()}
              </>
            ) : null}

            {fetchError ? <div className="alert alert-error">{fetchError}</div> : null}

            <Dialog open={resultsOpen} onOpenChange={setResultsOpen}>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="w-full rounded-md border border-border bg-card px-4 py-2.5 text-left text-base font-medium"
                >
                  {activeFilterLabels.length > 0 ? '검색 결과' : '전체'} {filteredEquipment.length}건 보기
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {activeFilterLabels.length > 0 ? '검색 결과' : '전체'} {filteredEquipment.length}건
                  </DialogTitle>
                  {activeFilterLabels.length > 0 ? (
                    <DialogDescription>{activeFilterLabels.join(' · ')}</DialogDescription>
                  ) : null}
                </DialogHeader>
                <DialogBody className="space-y-0 p-0">{resultsListItems(() => setResultsOpen(false))}</DialogBody>
              </DialogContent>
            </Dialog>
          </div>
        )}

        {/* 모바일에서는 이 섹션이 사이드바 없이 단독으로 좌측 벽에 붙어 있었다 — xl 미만에서만
            좌우 여백을 직접 주고, xl 이상(사이드바와 나란히 배치)에서는 기존 그대로 되돌린다. */}
        <div className="flex w-full min-w-0 flex-1 justify-center pt-4 pb-14 pl-5 pr-3 sm:pt-5 xl:pl-0 xl:pr-[clamp(1rem,2.5vw,2rem)]">
          <div className="grid w-full max-w-[1360px] grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="space-y-4 fade-rise-delay">
              <div className="surface-panel p-5">
                <div className="panel-header">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className={viewMode === 'map' ? 'app-nav-tab app-nav-tab--active' : 'app-nav-tab'}
                      onClick={() => setViewMode('map')}
                    >
                      지도
                    </button>
                    <button
                      type="button"
                      className={viewMode === 'list' ? 'app-nav-tab app-nav-tab--active' : 'app-nav-tab'}
                      onClick={() => setViewMode('list')}
                    >
                      목록
                    </button>
                  </div>
                </div>

                {viewMode === 'map' ? (
                  <div className="space-y-3">
                    {floorTabs}
                    {floorPins.length === 0 ? (
                      <div className="empty-state">이 층에는 아직 배치된 구역이 없습니다.</div>
                    ) : (
                      <>
                        <FloorMapView
                          floor={selectedFloor}
                          pins={floorPins}
                          equipment={floorEquipmentDots}
                          // 지도 마커 클릭은 그 점의 이름표만 여는 동작 — 목록에서 건 강조는 함께 풀어준다.
                          onEquipmentClick={() => setSelectedEquipment(null)}
                          zoneBounds={ZONE_BOUNDS}
                          highlightedZone={highlightedZone}
                          spotlightTagId={selectedEquipment}
                          spotlightReaderIds={realReaderIdsOnFloor}
                        />
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <span className="h-2.5 w-2.5 rounded-full map-marker-ok" />
                            사용 가능
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="h-2.5 w-2.5 rounded-full map-marker-err" />
                            대여 중
                          </span>
                          <span className="ml-auto">이미지 출처: 순천향대학교 천안병원</span>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {floorTabs}
                    {locationPanels.length === 0 ? (
                      <div className="empty-state">이 층에는 아직 수신된 RTLS 위치 데이터가 없습니다.</div>
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                        {locationPanels.map((location) => {
                          const roomItems = searchAndTypeFilteredEquipment.filter((eq) => eq.location === location);
                          const readerForLocation = readers.find((r) => r.location === location);
                          return (
                            <section key={location} className="rounded-lg border border-border bg-card p-4">
                              <div className="mb-4 flex items-center justify-between gap-3">
                                <div>
                                  <div className="flex items-center gap-2">
                                    <h3 className="text-[1.15rem]">{location}</h3>
                                    {readerForLocation ? (
                                      <span className={getOnlineDotClass(readerForLocation.is_online)} />
                                    ) : null}
                                  </div>
                                  <p className="mt-1 text-base text-muted-foreground">{roomItems.length}개 장비 수신</p>
                                </div>
                                <Badge variant="outline">{location}</Badge>
                              </div>
                              <div className="space-y-2">
                                {roomItems.length === 0 ? (
                                  <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-base text-muted-foreground">
                                    현재 태그 없음
                                  </div>
                                ) : (
                                  roomItems.map((eq) => (
                                    <button
                                      key={eq.id}
                                      type="button"
                                      onClick={() => toggleSelectedEquipment(eq.id)}
                                      className={`flex w-full items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-all ${
                                        selectedEquipment === eq.id
                                          ? 'border-foreground bg-secondary'
                                          : 'border-border bg-card hover:bg-secondary'
                                      }`}
                                    >
                                      <div className="min-w-0">
                                        <div className="truncate font-medium text-foreground">{eq.name}</div>
                                        <div className="mt-1 text-sm text-muted-foreground" title={eq.id}>
                                          {formatIBeaconTag(eq.id)}
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                        <span className={getAssetStatusColor(eq.assetStatus)} />
                                        <span className="whitespace-nowrap">{getAssetStatusLabel(eq.assetStatus)}</span>
                                      </div>
                                    </button>
                                  ))
                                )}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* 좁은 화면에서는 지도/목록으로 이미 구역별 장비를 볼 수 있어, 층별 구역 안내
                패널까지 세로로 쌓이면 화면을 너무 많이 차지한다 — xl(사이드바가 나란히
                배치되는 지점)부터만 보여준다. */}
            <section className="hidden space-y-4 fade-rise-delay xl:block">
              <div data-testid="zone-guide-panel" className="surface-panel surface-panel--muted p-5">
                <div className="panel-header">
                  <div>
                    <div className="panel-title">{FLOOR_MAPS.find((f) => f.floor === selectedFloor)?.label ?? ''}</div>
                  </div>
                </div>

                {zoneGuideRows.length === 0 ? (
                  <div className="empty-state">이 층에 안내할 구역이 없습니다.</div>
                ) : (
                  <div className="flex flex-col">
                    {zoneGuideRows.map((zone) => (
                      <button
                        key={zone.id}
                        type="button"
                        onClick={() => handleZoneGuideClick(zone)}
                        className={`flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left text-sm transition-all last:border-b-0 ${
                          highlightedZone?.id === zone.id
                            ? 'border-l-2 border-l-foreground bg-secondary'
                            : 'border-l-2 border-l-transparent hover:bg-secondary'
                        }`}
                      >
                        <span className="truncate">{zone.name}</span>
                        {zone.hasReader ? (
                          <span className="shrink-0 text-muted-foreground">{zone.equipmentCount}개</span>
                        ) : (
                          <span className="shrink-0 text-xs text-muted-foreground">편의시설</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
