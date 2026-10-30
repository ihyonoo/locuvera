import { describe, expect, it } from 'vitest';
import { ZONE_BOUNDS } from '../floorZoneBounds';
import type { FloorNumber } from '../floorMaps';
import { FLOOR_PLANS, readerFloor, zonePolygonsPx } from './floorPlans';
import type { Px } from './layout';

const FLOORS: FloorNumber[] = [1, 2, 3, 4, 5];
const inside = ([x, y]: Px, poly: Px[]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
const readersOn = (floor: FloorNumber) =>
  Object.keys(ZONE_BOUNDS)
    .filter((id) => readerFloor(id) === floor)
    .sort();

describe('readerFloor', () => {
  it('reads the floor from every traced reader id', () => {
    for (const id of Object.keys(ZONE_BOUNDS)) expect(readerFloor(id), id).toBeGreaterThanOrEqual(1);
    expect(readerFloor('M208')).toBe(2);
    expect(readerFloor('M501')).toBe(5);
  });

  it('rejects ids outside the M<floor><number> rule', () => {
    expect(readerFloor('M601')).toBeNull();
    expect(readerFloor('R101')).toBeNull();
    expect(readerFloor('M1')).toBeNull();
  });
});

describe('FLOOR_PLANS', () => {
  it('labels exactly the reader zones of its own floor', () => {
    for (const floor of FLOORS) {
      expect(Object.keys(FLOOR_PLANS[floor].zoneLabels).sort(), `${floor}층`).toEqual(readersOn(floor));
    }
  });

  it('puts every zone label inside its zone', () => {
    for (const floor of FLOORS) {
      const plan = FLOOR_PLANS[floor];
      for (const { readerId, poly } of zonePolygonsPx(plan, ZONE_BOUNDS)) {
        expect(inside(plan.zoneLabels[readerId].at, poly), readerId).toBe(true);
      }
    }
  });

  it('keeps the outline a polygon within the 930×976 floor image', () => {
    for (const floor of FLOORS) {
      const { outline } = FLOOR_PLANS[floor];
      expect(outline.length).toBeGreaterThanOrEqual(4);
      for (const [x, y] of outline) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(930);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(976);
      }
    }
  });

  it('stores cores as rectangles and names rooms with a label spot', () => {
    for (const floor of FLOORS) {
      const plan = FLOOR_PLANS[floor];
      expect(plan.floor).toBe(floor);
      for (const [kind, x1, y1, x2, y2] of plan.cores) {
        expect(['EV', 'ST', 'ES', 'WC']).toContain(kind);
        expect(x2).toBeGreaterThan(x1);
        expect(y2).toBeGreaterThan(y1);
      }
      for (const room of plan.rooms) if (room.name) expect(room.at, room.name).toBeDefined();
    }
  });
});

describe('zonePolygonsPx', () => {
  it('converts only this floor’s percent polygons to image px', () => {
    const zones = zonePolygonsPx(FLOOR_PLANS[2], ZONE_BOUNDS);
    expect(zones.map((z) => z.readerId).sort()).toEqual(readersOn(2));
    const m208 = zones.find((z) => z.readerId === 'M208')!;
    const [x0, y0] = m208.poly[0];
    // 벽선에 붙는(snap) 만큼만 어긋난다
    expect(Math.abs(x0 - ZONE_BOUNDS.M208[0].x * 9.3)).toBeLessThanOrEqual(3.2);
    expect(Math.abs(y0 - ZONE_BOUNDS.M208[0].y * 9.76)).toBeLessThanOrEqual(3.2);
  });
});
