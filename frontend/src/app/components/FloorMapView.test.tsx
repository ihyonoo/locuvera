import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import FloorMapView from './FloorMapView';
import { pointInPolygon, distanceToPolygonEdge, type ZonePoint } from '../lib/floorMapLayout';

// 지도 상자 폭 — 핀 지름은 이 폭의 2%다(기본 700px → 14px)
function mockContainerRect(width = 700) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: width,
    width,
    height: width,
    toJSON: () => {},
  });
}

const SQUARE_BOUNDS: Record<string, ZonePoint[]> = {
  M101: [
    { x: 20, y: 50 },
    { x: 30, y: 50 },
    { x: 30, y: 60 },
    { x: 20, y: 60 },
  ],
};

describe('FloorMapView', () => {
  beforeEach(() => {
    mockContainerRect();
  });

  it('renders the floor image for the given floor', () => {
    render(<FloorMapView floor={3} pins={[]} zoneBounds={{}} />);
    const img = screen.getByRole('img', { name: '3층 평면도' });
    expect(img).toHaveAttribute('src', '/images/floor-maps/3f.png');
  });

  it('draws no reader marker at all by default — the floor plan already labels every zone', () => {
    render(<FloorMapView floor={1} pins={[{ reader_id: 'M101', label: '주사센터' }]} zoneBounds={{}} />);

    expect(screen.queryByTestId('floor-map-pin-M101')).not.toBeInTheDocument();
    expect(screen.queryByText('주사센터')).not.toBeInTheDocument();
  });

  it('renders equipment dots near their reader pin and reports clicks', () => {
    const onEquipmentClick = vi.fn();
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-0001', reader_id: 'M101', label: '수액펌프 1호' }]}
        onEquipmentClick={onEquipmentClick}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );
    const dot = screen.getByTestId('floor-map-equipment-EQ-0001');
    expect(dot).toBeInTheDocument();
    fireEvent.click(dot);
    expect(onEquipmentClick).toHaveBeenCalledWith('EQ-0001');
  });

  it('colors a checked-out equipment dot differently from an available one', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[
          { tag_id: 'EQ-FREE', reader_id: 'M101', label: '수액펌프 1호', assetStatus: 'available' },
          { tag_id: 'EQ-BUSY', reader_id: 'M101', label: '수액펌프 2호', assetStatus: 'checked_out' },
        ]}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );

    expect(screen.getByTestId('floor-map-equipment-dot-EQ-FREE')).toHaveClass('map-marker-ok');
    expect(screen.getByTestId('floor-map-equipment-dot-EQ-BUSY')).toHaveClass('map-marker-err');
  });

  it('draws equipment dots as glossy balls (no white rim)', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-FREE', reader_id: 'M101', label: '수액펌프 1호', assetStatus: 'available' }]}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );

    expect(screen.getByTestId('floor-map-equipment-dot-EQ-FREE')).toHaveClass('map-marker-dot');
  });

  it('marks inactive equipment with its own color', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-OFF', reader_id: 'M101', label: '비활성 장비', assetStatus: 'inactive' }]}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );

    expect(screen.getByTestId('floor-map-equipment-dot-EQ-OFF')).toHaveClass('map-marker-neutral');
  });

  it('includes the asset status in the equipment tooltip', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-BUSY', reader_id: 'M101', label: '수액펌프 2호', assetStatus: 'checked_out' }]}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );

    expect(screen.getByTestId('floor-map-equipment-EQ-BUSY')).toHaveAttribute('title', '수액펌프 2호 · 대여 중');
  });

  it('does not draw a visible label next to the equipment marker — name is tooltip-only', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-0001', reader_id: 'M101', label: '이동형 초음파기기 1호' }]}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );

    expect(screen.queryByText('이동형 초음파기기')).not.toBeInTheDocument();
    expect(screen.queryByText('이동형 초음파기기 1호')).not.toBeInTheDocument();
    expect(screen.getByTestId('floor-map-equipment-EQ-0001')).toHaveAttribute(
      'title',
      '이동형 초음파기기 1호 · 사용 가능',
    );
  });

  it('renders equipment dots at 14px with no background ring', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-0001', reader_id: 'M101', label: '수액펌프 1호' }]}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );

    const dot = screen.getByTestId('floor-map-equipment-dot-EQ-0001');
    expect(dot.style.width).toBe('14px');
    expect(dot.style.height).toBe('14px');
    expect(dot.className).not.toContain('ring-background');
  });

  it('renders a highlight marker at the given zone position when highlightedZone is set', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[]}
        zoneBounds={{}}
        highlightedZone={{ id: '1f-cafe', label: '카페', mapX: 19, mapY: 57 }}
      />,
    );

    const highlight = screen.getByTestId('floor-map-highlight-1f-cafe');
    expect(highlight.style.left).toBe('19%');
    expect(highlight.style.top).toBe('57%');
  });

  it('renders no highlight marker when highlightedZone is not set', () => {
    render(<FloorMapView floor={1} pins={[]} zoneBounds={{}} />);
    expect(screen.queryByTestId(/floor-map-highlight-/)).not.toBeInTheDocument();
  });

  it('places a single equipment dot inside its zone polygon', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-0001', reader_id: 'M101', label: '수액펌프 1호' }]}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );
    const dot = screen.getByTestId('floor-map-equipment-EQ-0001');
    const left = parseFloat(dot.style.left);
    const top = parseFloat(dot.style.top);
    expect(left).toBeGreaterThanOrEqual(20);
    expect(left).toBeLessThanOrEqual(30);
    expect(top).toBeGreaterThanOrEqual(50);
    expect(top).toBeLessThanOrEqual(60);
  });

  it('keeps a single equipment dot off the border of an L-shaped zone whose centroid falls outside', () => {
    // L자 구역 — 면적 중심 (11, 11)이 폴리곤 밖이라 예전에는 첫 정점(0, 0), 즉 모서리에 찍혔다.
    const lShaped: ZonePoint[] = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 30 },
      { x: 0, y: 30 },
    ];
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-0001', reader_id: 'M101', label: '수액펌프 1호' }]}
        zoneBounds={{ M101: lShaped }}
      />,
    );
    const dot = screen.getByTestId('floor-map-equipment-EQ-0001');
    const position = { x: parseFloat(dot.style.left), y: parseFloat(dot.style.top) };
    expect(pointInPolygon(position, lShaped)).toBe(true);
    expect(distanceToPolygonEdge(position, lShaped)).toBeGreaterThanOrEqual(2);
  });

  it('does not draw anything for a reader with no traced polygon', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M999', label: '경계 없는 구역' }]}
        equipment={[{ tag_id: 'EQ-0002', reader_id: 'M999', label: '장비' }]}
        zoneBounds={{}}
      />,
    );
    expect(screen.queryByTestId('floor-map-equipment-EQ-0002')).not.toBeInTheDocument();
  });

  it('shows the equipment name label above the dot when clicked, and hides it on a second click', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-0001', reader_id: 'M101', label: '수액펌프 1호' }]}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );
    expect(screen.queryByTestId('floor-map-equipment-label-EQ-0001')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('floor-map-equipment-EQ-0001'));
    expect(screen.getByTestId('floor-map-equipment-label-EQ-0001')).toHaveTextContent('수액펌프 1호');

    fireEvent.click(screen.getByTestId('floor-map-equipment-EQ-0001'));
    expect(screen.queryByTestId('floor-map-equipment-label-EQ-0001')).not.toBeInTheDocument();
  });

  it('places multiple equipment inside the same zone polygon without lining them up in a row', () => {
    const roomyBounds: Record<string, ZonePoint[]> = {
      M101: [
        { x: 10, y: 10 },
        { x: 40, y: 10 },
        { x: 40, y: 40 },
        { x: 10, y: 40 },
      ],
    };
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[
          { tag_id: 'EQ-0001', reader_id: 'M101', label: '제세동기' },
          { tag_id: 'EQ-0002', reader_id: 'M101', label: '환자모니터' },
        ]}
        zoneBounds={roomyBounds}
      />,
    );
    const first = screen.getByTestId('floor-map-equipment-EQ-0001');
    const second = screen.getByTestId('floor-map-equipment-EQ-0002');
    for (const el of [first, second]) {
      const left = parseFloat(el.style.left);
      const top = parseFloat(el.style.top);
      expect(left).toBeGreaterThanOrEqual(10);
      expect(left).toBeLessThanOrEqual(40);
      expect(top).toBeGreaterThanOrEqual(10);
      expect(top).toBeLessThanOrEqual(40);
    }
    expect(first.style.left === second.style.left && first.style.top === second.style.top).toBe(false);
  });

  it('clusters equipment into a +N badge once the zone is too small to show them all individually, and expands the list on click', () => {
    const tinyBounds: Record<string, ZonePoint[]> = {
      M101: [
        { x: 10, y: 10 },
        { x: 12, y: 10 },
        { x: 12, y: 12 },
        { x: 10, y: 12 },
      ],
    };
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[
          { tag_id: 'EQ-0001', reader_id: 'M101', label: '제세동기', assetStatus: 'available' },
          { tag_id: 'EQ-0002', reader_id: 'M101', label: '환자모니터', assetStatus: 'checked_out' },
          { tag_id: 'EQ-0003', reader_id: 'M101', label: '인공호흡기', assetStatus: 'available' },
        ]}
        zoneBounds={tinyBounds}
      />,
    );
    // 2x2 퍼센트짜리 방은 maxVisibleForPolygon이 1이라, 3개 전부 배지 하나로 뭉친다.
    const badge = screen.getByTestId('floor-map-cluster-M101');
    expect(badge).toHaveTextContent('+3');
    expect(screen.queryByTestId('floor-map-cluster-list-M101')).not.toBeInTheDocument();

    fireEvent.click(badge);
    const list = screen.getByTestId('floor-map-cluster-list-M101');
    expect(within(list).getByTestId('floor-map-cluster-item-EQ-0001')).toHaveTextContent('제세동기');
    expect(within(list).getByTestId('floor-map-cluster-item-EQ-0002')).toHaveTextContent('환자모니터');
    expect(within(list).getByTestId('floor-map-cluster-item-EQ-0003')).toHaveTextContent('인공호흡기');

    fireEvent.click(badge);
    expect(screen.queryByTestId('floor-map-cluster-list-M101')).not.toBeInTheDocument();
  });

  it('closes the name label when a cluster badge elsewhere is opened (single active overlay)', () => {
    const bounds: Record<string, ZonePoint[]> = {
      M101: [
        { x: 10, y: 10 },
        { x: 40, y: 10 },
        { x: 40, y: 40 },
        { x: 10, y: 40 },
      ],
      M102: [
        { x: 10, y: 10.1 },
        { x: 12, y: 10.1 },
        { x: 12, y: 12.1 },
        { x: 10, y: 12.1 },
      ],
    };
    render(
      <FloorMapView
        floor={1}
        pins={[
          { reader_id: 'M101', label: '병동 A' },
          { reader_id: 'M102', label: '병동 B' },
        ]}
        equipment={[
          { tag_id: 'EQ-0001', reader_id: 'M101', label: '단일 장비' },
          { tag_id: 'EQ-0002', reader_id: 'M102', label: '장비2' },
          { tag_id: 'EQ-0003', reader_id: 'M102', label: '장비3' },
        ]}
        zoneBounds={bounds}
      />,
    );
    fireEvent.click(screen.getByTestId('floor-map-equipment-EQ-0001'));
    expect(screen.getByTestId('floor-map-equipment-label-EQ-0001')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('floor-map-cluster-M102'));
    expect(screen.queryByTestId('floor-map-equipment-label-EQ-0001')).not.toBeInTheDocument();
    expect(screen.getByTestId('floor-map-cluster-list-M102')).toBeInTheDocument();
  });

  function renderSpotlighted() {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[
          { tag_id: 'EQ-0001', reader_id: 'M101', label: '수액펌프 1호' },
          { tag_id: 'EQ-0002', reader_id: 'M101', label: '수액펌프 2호' },
        ]}
        zoneBounds={SQUARE_BOUNDS}
        spotlightTagId="EQ-0001"
      />,
    );
  }

  it('enlarges the spotlighted equipment dot beyond the normal 14px', () => {
    renderSpotlighted();
    expect(parseFloat(screen.getByTestId('floor-map-equipment-dot-EQ-0001').style.width)).toBeGreaterThan(14);
    expect(screen.getByTestId('floor-map-equipment-dot-EQ-0002').style.width).toBe('14px');
  });

  it('gives the spotlighted equipment dot the glow style and leaves the others plain', () => {
    renderSpotlighted();
    expect(screen.getByTestId('floor-map-equipment-dot-EQ-0001')).toHaveClass('map-marker-spotlight');
    expect(screen.getByTestId('floor-map-equipment-dot-EQ-0002')).not.toHaveClass('map-marker-spotlight');
  });

  it('draws a pulsing ring around the spotlighted equipment dot only', () => {
    renderSpotlighted();
    expect(screen.getByTestId('floor-map-equipment-ring-EQ-0001')).toHaveClass('animate-ping');
    expect(screen.queryByTestId('floor-map-equipment-ring-EQ-0002')).not.toBeInTheDocument();
  });

  it('highlights nothing when no equipment is spotlighted', () => {
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[{ tag_id: 'EQ-0001', reader_id: 'M101', label: '수액펌프 1호' }]}
        zoneBounds={SQUARE_BOUNDS}
      />,
    );

    expect(screen.getByTestId('floor-map-equipment-dot-EQ-0001')).not.toHaveClass('map-marker-spotlight');
    expect(screen.queryByTestId('floor-map-equipment-ring-EQ-0001')).not.toBeInTheDocument();
  });

  it('blinks the cluster badge instead when the spotlighted equipment is hidden inside it', () => {
    const tinyBounds: Record<string, ZonePoint[]> = {
      M101: [
        { x: 10, y: 10 },
        { x: 12, y: 10 },
        { x: 12, y: 12 },
        { x: 10, y: 12 },
      ],
    };
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[
          { tag_id: 'EQ-0001', reader_id: 'M101', label: '제세동기' },
          { tag_id: 'EQ-0002', reader_id: 'M101', label: '환자모니터' },
          { tag_id: 'EQ-0003', reader_id: 'M101', label: '인공호흡기' },
        ]}
        zoneBounds={tinyBounds}
        spotlightTagId="EQ-0003"
      />,
    );

    // 2x2 퍼센트 방은 상한이 1이라 3개 전부 배지로 뭉친다 — 개별 마커가 없으니 배지가 대신 깜빡인다.
    expect(screen.queryByTestId('floor-map-equipment-dot-EQ-0003')).not.toBeInTheDocument();
    expect(screen.getByTestId('floor-map-cluster-M101')).toHaveClass('animate-pulse');
  });

  it('leaves the cluster badge steady when the spotlighted equipment is not inside it', () => {
    const tinyBounds: Record<string, ZonePoint[]> = {
      M101: [
        { x: 10, y: 10 },
        { x: 12, y: 10 },
        { x: 12, y: 12 },
        { x: 10, y: 12 },
      ],
    };
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[
          { tag_id: 'EQ-0001', reader_id: 'M101', label: '제세동기' },
          { tag_id: 'EQ-0002', reader_id: 'M101', label: '환자모니터' },
        ]}
        zoneBounds={tinyBounds}
        spotlightTagId="EQ-9999"
      />,
    );

    expect(screen.getByTestId('floor-map-cluster-M101')).not.toHaveClass('animate-pulse');
  });
});

describe('FloorMapView real-hardware spotlight', () => {
  beforeEach(() => {
    mockContainerRect();
  });

  const TWO_ZONES: Record<string, ZonePoint[]> = {
    M101: SQUARE_BOUNDS.M101,
    M501: [
      { x: 60, y: 50 },
      { x: 70, y: 50 },
      { x: 70, y: 60 },
      { x: 60, y: 60 },
    ],
  };

  it('draws no dimming overlay when no spotlight is requested', () => {
    render(<FloorMapView floor={1} pins={[]} zoneBounds={TWO_ZONES} />);

    expect(screen.queryByTestId('floor-map-spotlight')).not.toBeInTheDocument();
  });

  it('dims the floor and cuts a hole for each spotlit zone', () => {
    render(<FloorMapView floor={1} pins={[]} zoneBounds={TWO_ZONES} spotlightReaderIds={['M501']} />);

    const spotlight = screen.getByTestId('floor-map-spotlight');
    expect(spotlight).toBeInTheDocument();
    expect(within(spotlight).getByTestId('floor-map-spotlight-hole-M501')).toBeInTheDocument();
    expect(within(spotlight).queryByTestId('floor-map-spotlight-hole-M101')).not.toBeInTheDocument();
  });

  it('still dims the floor when no zone on it has real hardware', () => {
    render(<FloorMapView floor={2} pins={[]} zoneBounds={TWO_ZONES} spotlightReaderIds={[]} />);

    const spotlight = screen.getByTestId('floor-map-spotlight');
    expect(spotlight).toBeInTheDocument();
    expect(within(spotlight).queryByTestId(/floor-map-spotlight-hole-/)).not.toBeInTheDocument();
  });

  it('ignores a spotlit reader that has no polygon on this floor', () => {
    render(<FloorMapView floor={1} pins={[]} zoneBounds={TWO_ZONES} spotlightReaderIds={['M999']} />);

    const spotlight = screen.getByTestId('floor-map-spotlight');
    expect(within(spotlight).queryByTestId('floor-map-spotlight-hole-M999')).not.toBeInTheDocument();
  });
});

describe('FloorMapView pin size follows the map like a photo', () => {
  function renderAtWidth(width: number) {
    vi.restoreAllMocks();
    mockContainerRect(width);
    render(
      <FloorMapView
        floor={1}
        pins={[{ reader_id: 'M101', label: '병동 A' }]}
        equipment={[
          { tag_id: 'EQ-0001', reader_id: 'M101', label: '수액펌프 1호' },
          { tag_id: 'EQ-0002', reader_id: 'M101', label: '수액펌프 2호' },
        ]}
        zoneBounds={SQUARE_BOUNDS}
        spotlightTagId="EQ-0001"
      />,
    );
  }

  it('makes a normal dot 2% of the map box width', () => {
    renderAtWidth(500);
    expect(screen.getByTestId('floor-map-equipment-dot-EQ-0002').style.width).toBe('10px');
  });

  it('keeps the spotlight dot and ring in the old 14 : 22 : 40 proportion', () => {
    renderAtWidth(500);
    expect(parseFloat(screen.getByTestId('floor-map-equipment-dot-EQ-0001').style.width)).toBeCloseTo((10 * 22) / 14);
    expect(parseFloat(screen.getByTestId('floor-map-equipment-ring-EQ-0001').style.width)).toBeCloseTo((10 * 40) / 14);
  });

  it('keeps the touch target at 28px even when the dot is tiny', () => {
    renderAtWidth(330);
    const button = screen.getByTestId('floor-map-equipment-EQ-0002');
    expect(button.style.width).toBe('28px');
    expect(button.style.height).toBe('28px');
  });

  it('marks the floor plan image so dark mode can invert it', () => {
    renderAtWidth(500);
    expect(screen.getByRole('img', { name: '1층 평면도' })).toHaveClass('floor-map__plan');
  });
});
