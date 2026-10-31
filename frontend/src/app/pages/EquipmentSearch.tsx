import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
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
import StaffShell from '../components/layout/StaffShell';
import { PillToggle, ToggleSwitch } from '../components/layout/staffControls';
import FloorMapView, {
  type FloorMapPin,
  type FloorMapEquipmentDot,
  type FloorMapHighlight,
} from '../components/FloorMapView';
import Map3DBoundary from '../components/floor3d/Map3DBoundary';
import { FLOOR_MAPS, type FloorNumber } from '../lib/floorMaps';
import { DEFAULT_MAP_DIMENSION, isWebGLAvailable, type MapDimension } from '../lib/mapDimension';
import { getAmenityZonesForFloor } from '../lib/floorZones';
import { ZONE_BOUNDS } from '../lib/floorZoneBounds';
import { polygonCentroid } from '../lib/floorMapLayout';
import { formatIBeaconTag } from '../lib/iBeaconTag';
import { API_BASE_URL } from '../lib/runtime';
import { buildAuthHeaders, getStoredAuthSession, LOGIN_PATH } from '../lib/auth';
import { useAuthGuard, useLogout } from '../lib/useAuthGuard';
import { useMediaQuery } from '../lib/useMediaQuery';

// 사이드바가 지도 옆에 나란히 붙는 시점(xl) — 그 미만에서는 사이드바 대신
// 위에 검색칸·상세검색 + 결과 목록 창을 쓴다.
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

// three.js는 3D 보기를 쓸 때만 내려받는다
const FloorMap3D = lazy(() => import('../components/floor3d/FloorMap3D'));

// 상태 점 — 지도 핀과 같은 색(초록 사용 가능, 빨강 대여 중, 회색 비활성)
function statusLedClass(status: string) {
  if (status === 'checked_out') return 'staff-led staff-led--busy';
  if (status === 'inactive') return 'staff-led staff-led--off';
  return 'staff-led';
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
  // 층 지도 2D/3D. 열 때마다 3D이고 2D는 이 화면에서 고를 때만 쓴다(기억하지 않음).
  // WebGL이 없으면 항상 2D, 3D가 실패하면 이 화면에서만 2D로 바꾼다.
  const [webglAvailable] = useState(isWebGLAvailable);
  const [mapDimension, setMapDimension] = useState<MapDimension>(webglAvailable ? DEFAULT_MAP_DIMENSION : '2d');
  const [map3dFailed, setMap3dFailed] = useState(false);
  const chooseMapDimension = (value: MapDimension) => {
    setMapDimension(value);
    setMap3dFailed(false);
  };
  const showing3d = mapDimension === '3d' && webglAvailable && !map3dFailed;
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

  // 지도에는 장비 이름만 쓴다 — 일련번호('수액펌프-001'의 '-001')는 목록에만 보인다
  const floorEquipmentDots = useMemo<FloorMapEquipmentDot[]>(() => {
    const pinReaderIds = new Set(floorPins.map((p) => p.reader_id));
    return searchAndTypeFilteredEquipment
      .filter((eq) => pinReaderIds.has(eq.readerId))
      .map((eq) => ({
        tag_id: eq.id,
        reader_id: eq.readerId,
        label: eq.name.replace(/-\d+$/, ''),
        assetStatus: eq.assetStatus,
      }));
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

  // 층 단추 — 동그란 1F~5F(화면 낭독기는 'n층'). 지도 보기와 목록 보기가 같은 층을 쓴다.
  // 넓은 화면은 지도 오른쪽 세로(위가 높은 층), 좁은 화면은 지도 위 가로 한 줄
  const floorButtons = (stacked: boolean) => (
    <div
      data-testid="floor-tabs"
      role="group"
      aria-label="층 선택"
      className={stacked ? 'staff-elevator staff-elevator--row' : 'staff-elevator'}
    >
      {(stacked ? FLOOR_MAPS : [...FLOOR_MAPS].reverse()).map((f) => (
        <button
          key={f.floor}
          type="button"
          aria-label={f.label}
          aria-pressed={f.floor === selectedFloor}
          className={f.floor === selectedFloor ? 'staff-floor staff-floor--on' : 'staff-floor'}
          onClick={() => {
            setSelectedFloor(f.floor);
            setHighlightedZone(null);
            setSelectedEquipment(null);
          }}
        >
          {f.floor}F
        </button>
      ))}
    </div>
  );

  // 같은 장비를 다시 고르면 강조를 끈다 — 지도에서 계속 깜빡이는 점이 남지 않게.
  const toggleSelectedEquipment = (tagId: string) => {
    setSelectedEquipment((prev) => (prev === tagId ? null : tagId));
  };

  const searchField = (
    <div className="staff-search">
      <Search className="staff-search__icon" aria-hidden="true" />
      <input
        aria-label="장비 검색"
        placeholder="태그 ID, 장비명, 위치 검색"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />
    </div>
  );

  // 검색/필터 필드들 — 넓은 화면 사이드바(두 칸 격자)와 좁은 화면 가로 스크롤 줄에서 함께 쓴다.
  // compact=true면 스크롤 줄 안에서 줄어들지 않는 폭을 준다.
  const typeFilterField = (compact: boolean) => (
    <div className={compact ? 'w-36 shrink-0' : undefined}>
      <label>장비 유형</label>
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
    <div className={compact ? 'w-28 shrink-0' : undefined}>
      <label>층</label>
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
    <div className={compact ? 'w-36 shrink-0' : undefined}>
      <label>위치 필터</label>
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

  // 두 스위치는 짝이라 한 줄에 둔다 — 폭이 좁으면 자동으로 줄바꿈된다.
  const toggleFilters = (
    <div data-testid="equipment-filter-toggles" className="staff-switches">
      <ToggleSwitch checked={availableOnly} onChange={setAvailableOnly}>
        사용 가능만
      </ToggleSwitch>
      <ToggleSwitch checked={hideSimulated} onChange={setHideSimulated}>
        시뮬레이션 숨김
      </ToggleSwitch>
    </div>
  );

  const resultTitle = `${activeFilterLabels.length > 0 ? '검색 결과' : '전체'} ${filteredEquipment.length}건`;

  // 필터링된 장비 목록 — 넓은 화면 사이드바에서는 그대로, 좁은 화면 결과 창에서는
  // 항목을 고르면 창을 닫도록 afterSelect를 넘긴다.
  const resultsListItems = (afterSelect?: () => void) => {
    if (isLoading) {
      return <div className="staff-empty">실시간 데이터를 불러오는 중입니다.</div>;
    }
    if (filteredEquipment.length === 0) {
      return <div className="staff-empty">조건에 맞는 장비가 없습니다.</div>;
    }
    return filteredEquipment.map((item) => (
      <button
        key={item.id}
        type="button"
        title={item.id}
        aria-pressed={selectedEquipment === item.id}
        className={selectedEquipment === item.id ? 'staff-row staff-row--on' : 'staff-row'}
        onClick={() => {
          toggleSelectedEquipment(item.id);
          afterSelect?.();
        }}
      >
        <span className="staff-row__main">
          <span className="staff-row__name">{item.name}</span>
          <span className="staff-row__sub">
            {item.location}
            {item.currentHolderName ? ` · ${item.currentHolderName}` : ''}
          </span>
        </span>
        <span className={statusLedClass(item.assetStatus)} title={getAssetStatusLabel(item.assetStatus)} />
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

  // 지도 — 3D는 받침 폭을 채우고(높이는 CSS), 2D는 평면도 비율 그대로
  const mapView = showing3d ? (
    <div className="staff-map staff-map--3d">
      <Map3DBoundary onError={() => setMap3dFailed(true)}>
        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
              3D 지도를 불러오는 중…
            </div>
          }
        >
          <FloorMap3D
            floor={selectedFloor}
            pins={floorPins}
            equipment={floorEquipmentDots}
            onEquipmentClick={() => setSelectedEquipment(null)}
            zoneBounds={ZONE_BOUNDS}
            highlightedZone={highlightedZone}
            spotlightTagId={selectedEquipment}
            spotlightReaderIds={realReaderIdsOnFloor}
            onUnavailable={() => setMap3dFailed(true)}
          />
        </Suspense>
      </Map3DBoundary>
    </div>
  ) : (
    <div className="staff-map staff-map--2d">
      {map3dFailed && mapDimension === '3d' ? (
        <div role="status" className="staff-empty staff-empty--inline">
          3D 보기를 불러오지 못해 2D로 표시합니다.
        </div>
      ) : null}
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
    </div>
  );

  // 목록 보기 — 한 줄에 구역 하나, 구역 안 장비는 가로 칸. 층 단추만 따른다(사이드바 층 필터와 무관)
  const listView =
    locationPanels.length === 0 ? (
      <div className="staff-empty">이 층에는 아직 수신된 위치 데이터가 없습니다.</div>
    ) : (
      <div className="staff-groups">
        {locationPanels.map((location) => {
          const roomItems = searchAndTypeFilteredEquipment.filter((eq) => eq.location === location);
          const reader = readers.find((r) => r.location === location);
          return (
            <section key={location}>
              <header className="staff-group__head">
                <h3 className="staff-group__name">
                  {reader ? <span className={reader.is_online ? 'staff-led' : 'staff-led staff-led--warn'} /> : null}
                  {location}
                </h3>
                <span className="staff-num">{roomItems.length}</span>
              </header>
              {roomItems.length === 0 ? (
                <div className="staff-group__none">현재 장비 없음</div>
              ) : (
                <div className="staff-group__items">
                  {roomItems.map((eq) => (
                    <button
                      key={eq.id}
                      type="button"
                      title={eq.id}
                      aria-pressed={selectedEquipment === eq.id}
                      className={selectedEquipment === eq.id ? 'staff-row staff-row--on' : 'staff-row'}
                      onClick={() => toggleSelectedEquipment(eq.id)}
                    >
                      {/* 태그는 공유 uuid 대신 major·minor로 구분한다 */}
                      <span className="staff-row__main">
                        <span className="staff-row__name">{eq.name}</span>
                        <span className="staff-row__sub">{formatIBeaconTag(eq.id)}</span>
                      </span>
                      <span className="staff-row__status">
                        <span className={statusLedClass(eq.assetStatus)} />
                        {getAssetStatusLabel(eq.assetStatus)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    );

  // 지도 패널 — 지도/목록 전환, 2D/3D 전환, 받침, 층 단추, 범례
  const mapPanel = (
    <section className="staff-panel">
      <div className="staff-equip__bar">
        <PillToggle
          label="보기"
          value={viewMode}
          options={[
            { value: 'map', label: '지도' },
            { value: 'list', label: '목록' },
          ]}
          onChange={setViewMode}
        />
        {viewMode === 'map' ? (
          <PillToggle
            small
            label="지도 차원"
            testId="map-dimension-toggle"
            value={showing3d ? '3d' : '2d'}
            options={[
              { value: '2d', label: '2D' },
              {
                value: '3d',
                label: '3D',
                disabled: !webglAvailable,
                title: webglAvailable ? undefined : '이 기기에서는 3D 보기를 쓸 수 없습니다',
              },
            ]}
            onChange={chooseMapDimension}
          />
        ) : null}
      </div>
      <div className={isDesktop ? 'staff-equip__stage' : 'staff-equip__stage staff-equip__stage--stacked'}>
        <div className="staff-tray">
          {viewMode === 'list' ? (
            listView
          ) : floorPins.length === 0 ? (
            <div className="staff-empty">이 층에는 아직 배치된 구역이 없습니다.</div>
          ) : (
            mapView
          )}
        </div>
        {floorButtons(!isDesktop)}
      </div>
      {viewMode === 'map' && floorPins.length > 0 ? (
        <div className="staff-equip__foot">
          <div className="staff-legend">
            <span>
              <span className="staff-led" /> 사용 가능
            </span>
            <span>
              <span className="staff-led staff-led--busy" /> 대여 중
            </span>
          </div>
          <span className="staff-credit">이미지 출처: 순천향대학교 천안병원</span>
        </div>
      ) : null}
    </section>
  );

  // 구역 패널(넓은 화면만) — 장비 추적 구역은 대수와 함께 누르면 지도 강조, 편의시설은 안내 글자만
  const trackedZones = zoneGuideRows.filter((zone) => zone.hasReader);
  const amenityZones = zoneGuideRows.filter((zone) => !zone.hasReader);
  const zonePanel = (
    <aside data-testid="zone-guide-panel" className="staff-panel staff-equip__zones" aria-label="구역 안내">
      <h2 className="staff-title staff-equip__zones-title">{selectedFloor}F</h2>
      <div className="staff-subhead">장비 추적 구역</div>
      {trackedZones.length === 0 ? (
        <div className="staff-empty staff-empty--inline">없음</div>
      ) : (
        trackedZones.map((zone) => (
          <button
            key={zone.id}
            type="button"
            aria-pressed={highlightedZone?.id === zone.id}
            className={highlightedZone?.id === zone.id ? 'staff-zone staff-zone--on' : 'staff-zone'}
            onClick={() => handleZoneGuideClick(zone)}
          >
            <span className="truncate">{zone.name}</span>
            <span
              className={zone.equipmentCount === 0 ? 'staff-zone__count staff-zone__count--zero' : 'staff-zone__count'}
            >
              {zone.equipmentCount}대
            </span>
          </button>
        ))
      )}
      {/* 편의시설이 없는 층은 제목째 숨긴다 */}
      {amenityZones.length > 0 ? (
        <>
          <div className="staff-subhead">편의시설</div>
          <ul className="staff-amenities">
            {amenityZones.map((zone) => (
              // 긴 이름은 두 칸을 다 쓴다
              <li
                key={zone.id}
                className={zone.name.length > 7 ? 'staff-amenity staff-amenity--wide' : 'staff-amenity'}
              >
                {zone.name}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </aside>
  );

  // 넓은 화면 사이드바 — 제목·추적 중, 검색, 필터, 스위치, 결과 요약, 결과 목록
  const sidebar = (
    <div data-testid="equipment-sidebar" className="staff-sidebar__body">
      <div className="staff-equip__head">
        <h1 className="staff-title">장비 검색</h1>
        <span className="staff-live" title="1초마다 갱신">
          <span className="staff-led staff-led--live" />
          추적 중 <span className="staff-num">{equipment.length}</span>
        </span>
      </div>
      {searchField}
      <div className="staff-fields">
        {typeFilterField(false)}
        {floorFilterField(false)}
        {locationFilterField(false)}
      </div>
      {toggleFilters}
      {fetchError ? <div className="staff-alert">{fetchError}</div> : null}
      <div data-testid="equipment-result-summary" className="staff-summary">
        <span>{resultTitle}</span>
        {activeFilterLabels.length > 0 ? (
          <span className="staff-summary__meta">{activeFilterLabels.join(' · ')}</span>
        ) : null}
      </div>
      <div className="staff-well staff-equip__list">{resultsListItems()}</div>
    </div>
  );

  if (isDesktop) {
    return (
      <StaffShell menu="staff" current="equipment" sidebar={sidebar} sidebarLabel="장비 검색 패널">
        <div className="staff-equip">
          {mapPanel}
          {zonePanel}
        </div>
      </StaffShell>
    );
  }

  // 좁은 화면 — 사이드바 대신 위에 검색칸·상세검색·결과 단추, 결과 목록은 창으로 뗀다.
  // 구역 패널은 지도·목록으로 이미 구역별 장비를 볼 수 있어 숨긴다.
  return (
    <StaffShell menu="staff" current="equipment">
      <div className="staff-equip__mobile">
        <div className="staff-equip__head">
          <h1 className="staff-title">장비 검색</h1>
          <span className="staff-live">
            <span className="staff-led staff-led--live" />
            추적 중 <span className="staff-num">{equipment.length}</span>
          </span>
        </div>
        {searchField}
        <button
          type="button"
          aria-expanded={advancedSearchOpen}
          onClick={() => setAdvancedSearchOpen((prev) => !prev)}
          className="staff-link-btn"
        >
          상세검색
          {advancedSearchOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {advancedSearchOpen ? (
          <>
            <div className="staff-fields staff-equip__filter-row">
              {typeFilterField(true)}
              {floorFilterField(true)}
              {locationFilterField(true)}
            </div>
            {toggleFilters}
          </>
        ) : null}
        {fetchError ? <div className="staff-alert">{fetchError}</div> : null}
        <Dialog open={resultsOpen} onOpenChange={setResultsOpen}>
          <DialogTrigger asChild>
            <button type="button" className="staff-results-btn">
              {resultTitle} 보기
            </button>
          </DialogTrigger>
          <DialogContent className="staff-tokens">
            <DialogHeader>
              <DialogTitle>{resultTitle}</DialogTitle>
              {activeFilterLabels.length > 0 ? (
                <DialogDescription>{activeFilterLabels.join(' · ')}</DialogDescription>
              ) : null}
            </DialogHeader>
            <DialogBody className="space-y-0 p-0">{resultsListItems(() => setResultsOpen(false))}</DialogBody>
          </DialogContent>
        </Dialog>
      </div>
      <div className="staff-equip">{mapPanel}</div>
    </StaffShell>
  );
}
