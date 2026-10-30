import { describe, expect, it } from 'vitest';
import { distanceToFloorText, floorTextLayout, placeEquipment, zoneKind, type Px } from './layout';

const inside = ([x, y]: Px, poly: Px[]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
const square = (x: number, y: number, size: number): Px[] => [
  [x, y],
  [x + size, y],
  [x + size, y + size],
  [x, y + size],
];
const dist = (a: Px, b: Px) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('zoneKind', () => {
  it('classifies zones by the first matching rule', () => {
    expect(zoneKind('중앙수술센터')).toBe('surgery');
    expect(zoneKind('통원수술센터')).toBe('surgery');
    expect(zoneKind('권역응급중환자실')).toBe('acute');
    expect(zoneKind('내과계중환자실 CCU')).toBe('acute');
    expect(zoneKind('충남권역심뇌혈관질환센터')).toBe('acute');
    // 소아·응급이 함께 있으면 응급이 먼저다
    expect(zoneKind('소아전문응급의료센터')).toBe('acute');
    expect(zoneKind('고위험분만센터')).toBe('family');
    expect(zoneKind('소아재활센터')).toBe('family');
    expect(zoneKind('진단검사의학센터')).toBe('exam');
    expect(zoneKind('투석센터')).toBe('exam');
    expect(zoneKind('가정의학센터')).toBe('outpatient');
  });
});

describe('placeEquipment', () => {
  it('places every tag inside the zone, 82px apart at full scale', () => {
    const room = square(100, 100, 400);
    const { spots, scale } = placeEquipment(room, ['t1', 't2', 't3']);
    expect(scale).toBe(1);
    expect([...spots.keys()].sort()).toEqual(['t1', 't2', 't3']);
    const points = [...spots.values()];
    for (const p of points) expect(inside(p, room)).toBe(true);
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) expect(dist(points[i], points[j])).toBeGreaterThanOrEqual(82);
  });

  it('gives the same spot to the same tag regardless of input order', () => {
    const room = square(0, 0, 400);
    const a = placeEquipment(room, ['b', 'a', 'c']).spots;
    const b = placeEquipment(room, ['c', 'b', 'a']).spots;
    for (const id of ['a', 'b', 'c']) expect(a.get(id)).toEqual(b.get(id));
  });

  it('never puts equipment on the zone name painted on the floor', () => {
    const room = square(0, 0, 400);
    const label = { at: [200, 200] as Px, lines: ['뇌신경센터'] };
    const text = floorTextLayout(room, label.lines);
    const { spots } = placeEquipment(room, ['t1', 't2', 't3', 't4'], label);
    for (const p of spots.values())
      expect(distanceToFloorText(p, label.at, label.lines, text)).toBeGreaterThanOrEqual(26);
  });

  it('shrinks equipment in a crowded zone so all of it fits', () => {
    // 경계 34px를 빼면 82×82만 남아, 4대를 82px 간격으로 세울 수 없다
    const room = square(0, 0, 150);
    const { spots, scale } = placeEquipment(room, ['a', 'b', 'c', 'd']);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThanOrEqual(0.45);
    expect(spots.size).toBe(4);
    for (const p of spots.values()) expect(inside(p, room)).toBe(true);
  });

  it('still places every tag at the smallest scale when nothing fits', () => {
    const room = square(0, 0, 70);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { spots, scale } = placeEquipment(room, ids);
    expect(scale).toBe(0.45);
    expect(spots.size).toBe(ids.length);
    for (const p of spots.values()) expect(inside(p, room)).toBe(true);
  });
});

describe('floorTextLayout', () => {
  const rect = (x: number, y: number, w: number, h: number): Px[] => [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const textWidth = (lines: string[], size: number) =>
    size * Math.max(...lines.map((l) => [...l].reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? 0.6 : 1), 0)));

  it('writes east-west when the name fits that way', () => {
    const { angle, size } = floorTextLayout(rect(0, 0, 300, 120), ['뇌신경센터']);
    expect(angle).toBe(0);
    expect(textWidth(['뇌신경센터'], size)).toBeLessThanOrEqual(300 * 0.8);
  });

  it('turns along the long wall when a narrow room cannot fit it east-west', () => {
    const { angle } = floorTextLayout(rect(0, 0, 60, 300), ['정신건강의학센터']);
    expect(Math.abs(Math.cos(angle))).toBeLessThan(1e-6);
  });

  it('keeps the tops of the letters facing away from the south-west camera', () => {
    for (const poly of [rect(0, 0, 60, 300), rect(0, 0, 300, 120)]) {
      const { angle } = floorTextLayout(poly, ['정신건강의학센터']);
      // 글자 머리 방향(평면 좌표) = 기준선을 -90° 돌린 방향. 북동쪽(1, -1)과 같은 쪽이어야 한다
      expect(Math.sin(angle) + Math.cos(angle)).toBeGreaterThan(0);
    }
  });

  it('stays between the readable minimum and the maximum size', () => {
    expect(floorTextLayout(rect(0, 0, 2000, 2000), ['채혈실']).size).toBe(28);
    expect(floorTextLayout(rect(0, 0, 40, 40), ['암치료센터', '종양혈액내과']).size).toBe(7);
  });
});
