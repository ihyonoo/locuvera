// 장비 검색 층 지도의 3D 보기. FloorMapView(2D)와 같은 props를 받는다. 지연 로딩 전용(default export).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FloorMapViewProps } from '../FloorMapView';
import { FLOOR_PLANS, zonePolygonsPx } from '../../lib/floor3d/floorPlans';
import { MAP_3D_ASPECT } from '../../lib/mapDimension';
import { equipmentLayerKey } from '../../lib/floor3d/runtime';
import { buildFloorModel, highlightPosition, placeEquipmentOnFloor, type ZonePx } from './buildFloor';
import { MapEngine } from './mapEngine';

type FloorMap3DProps = FloorMapViewProps & { onUnavailable: () => void };

export default function FloorMap3D({
  floor,
  pins,
  equipment = [],
  onEquipmentClick,
  zoneBounds,
  highlightedZone = null,
  spotlightReaderIds = null,
  spotlightTagId = null,
  onUnavailable,
}: FloorMap3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<SVGSVGElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  // 지도에서 누른 장비. 층이 바뀌면 자연히 풀리도록 층 번호와 함께 둔다
  const [active, setActive] = useState<{ floor: number; tagId: string } | null>(null);
  const activeTagId = active?.floor === floor ? active.tagId : null;
  const [showLabels, setShowLabels] = useState(true);
  const pickRef = useRef<(tagId: string) => void>(() => {});
  const unavailableRef = useRef(onUnavailable);
  useEffect(() => {
    pickRef.current = (tagId) => {
      setActive((prev) => (prev?.floor === floor && prev.tagId === tagId ? null : { floor, tagId }));
      onEquipmentClick?.(tagId);
    };
    unavailableRef.current = onUnavailable;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !layerRef.current || !leadRef.current) return;
    let engine: MapEngine;
    try {
      engine = new MapEngine(
        host,
        layerRef.current,
        leadRef.current,
        (id) => pickRef.current(id),
        () => unavailableRef.current(),
      );
    } catch {
      unavailableRef.current();
      return;
    }
    engineRef.current = engine;
    engine.resize();
    const observer = new ResizeObserver(() => engine.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const plan = FLOOR_PLANS[floor];
  // 1초마다 리더 목록이 새 배열로 와도, 구역 이름이 바뀔 때만 구역(과 층 모형·장비 점)을 다시 만든다
  const pinNamesKey = JSON.stringify(pins.map((p) => [p.reader_id, p.label]).sort());
  const zones = useMemo<ZonePx[]>(() => {
    const names = new Map<string, string>(JSON.parse(pinNamesKey));
    return zonePolygonsPx(plan, zoneBounds).map(({ readerId, poly }) => ({
      readerId,
      poly,
      name: names.get(readerId) ?? plan.zoneLabels[readerId]?.lines.join('') ?? readerId,
    }));
  }, [plan, zoneBounds, pinNamesKey]);
  const dimmedKey = spotlightReaderIds ? [...spotlightReaderIds].sort().join(',') : null;

  // 시점은 층이 바뀔 때만 맞춘다(어둡게 할 구역만 바뀌면 보던 시점을 둔다)
  const fittedFloorRef = useRef<number | null>(null);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const spotlight = dimmedKey === null ? null : new Set(dimmedKey.split(',').filter(Boolean));
    engine.setFloor(buildFloorModel(plan, zones, spotlight), fittedFloorRef.current !== plan.floor);
    fittedFloorRef.current = plan.floor;
  }, [plan, zones, dimmedKey]);

  // 1초마다 새 배열이 와도, 위치·상태가 바뀔 때만 장비 점을 다시 만든다
  const equipmentKey = equipmentLayerKey(equipment);
  const equipmentRef = useRef(equipment);
  useEffect(() => {
    equipmentRef.current = equipment;
  });
  useEffect(() => {
    engineRef.current?.setEquipment(placeEquipmentOnFloor(plan, zones, equipmentRef.current));
  }, [plan, zones, equipmentKey]);

  useEffect(() => {
    engineRef.current?.setFocus(spotlightTagId ?? activeTagId);
  }, [spotlightTagId, activeTagId, equipmentKey]);

  useEffect(() => {
    engineRef.current?.setHighlight(
      highlightedZone ? highlightPosition(highlightedZone.mapX, highlightedZone.mapY) : null,
    );
  }, [highlightedZone]);

  useEffect(() => {
    engineRef.current?.setLabelsVisible(showLabels);
  }, [showLabels]);

  return (
    <div
      ref={hostRef}
      data-testid="floor-map-3d"
      className="relative w-full select-none overflow-hidden rounded-lg border border-border bg-[#eef1f3]"
      style={{ aspectRatio: MAP_3D_ASPECT, touchAction: 'none' }}
    >
      <svg ref={leadRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      <div ref={layerRef} className="pointer-events-none absolute inset-0 overflow-hidden" />
      <div data-map-controls className="absolute right-3 top-3 flex gap-2">
        <label className="flex h-8 items-center gap-1.5 border border-border bg-card px-2.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
          이름표
        </label>
        <button
          type="button"
          className="h-8 border border-border bg-card px-2.5 text-xs text-muted-foreground"
          onClick={() => engineRef.current?.resetView()}
        >
          시점 초기화
        </button>
      </div>
    </div>
  );
}
