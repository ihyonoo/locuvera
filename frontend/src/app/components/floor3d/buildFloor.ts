// 층 데이터 → three.js 층 모형(벽 단면·문·창·바닥재·수직 동선)과 장비 층.
// 월드 단위는 원본 안내도 px(≈0.1m). X = px - cx, Z = py - cy, Y 위.
import * as THREE from 'three';
import type { FloorPlan, Room } from '../../lib/floor3d/floorPlans';
import {
  contains,
  edgeDistance,
  floorTextBox,
  floorTextLayout,
  placeEquipment,
  zoneKind,
  type Px,
  type ZoneKind,
} from '../../lib/floor3d/layout';

const CENTER: Px = [465, 488];
const WALL = 24;
const OUTER_T = 6;
const PART_T = 2.4;
const DOOR = 13;
const DOOR_H = 20;
const SILL = 7;
const HEAD = 19.5;
const SLAB = 8;
const WINDOW = 20;
const WINDOW_PERIOD = 60;
const GATE = 32;

// ── 텍스처와 재질(층 사이에서 공유, 해제하지 않는다) ──────────────
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
function canvasTex(size: number, draw: (x: CanvasRenderingContext2D, n: number) => void, worldPx: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  if (x) draw(x, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / worldPx, 1 / worldPx);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const terrazzoTex = (base: string, seed: number) =>
  canvasTex(
    512,
    (x, n) => {
      x.fillStyle = base;
      x.fillRect(0, 0, n, n);
      const R = rnd(seed);
      const chips = ['#8e8a84', '#b9b3aa', '#d8d2c8', '#6f6c68', '#f7f4ef', '#a59c90'];
      for (let i = 0; i < 2600; i++) {
        x.fillStyle = chips[Math.floor(R() * chips.length)];
        x.beginPath();
        const r = 0.8 + R() * 2.6;
        x.ellipse(R() * n, R() * n, r, r * (0.6 + R() * 0.6), R() * 3, 0, 7);
        x.fill();
      }
    },
    60,
  );
// 시트 비닐: 은은한 얼룩 + 미세 입자 + 2m 간격 용접 이음매
const vinylTex = (base: string, fleck: string[], seam: string, seed: number) =>
  canvasTex(
    1024,
    (x, n) => {
      x.fillStyle = base;
      x.fillRect(0, 0, n, n);
      const R = rnd(seed);
      for (let i = 0; i < 260; i++) {
        const v = R() > 0.5 ? 255 : 0;
        x.fillStyle = `rgba(${v},${v},${v},0.018)`;
        x.beginPath();
        x.ellipse(R() * n, R() * n, 30 + R() * 90, 20 + R() * 60, R() * 3, 0, 7);
        x.fill();
      }
      for (let i = 0; i < 9000; i++) {
        x.fillStyle = fleck[Math.floor(R() * fleck.length)];
        x.fillRect(R() * n, R() * n, 1.4 + R() * 1.6, 1.4 + R() * 1.6);
      }
      x.strokeStyle = seam;
      x.lineWidth = 2;
      for (let i = 0; i <= 2; i++) {
        x.beginPath();
        x.moveTo((i * n) / 2, 0);
        x.lineTo((i * n) / 2, n);
        x.stroke();
      }
    },
    40,
  );
// 수술실 전도성 바닥: 격자 이음매
const gridVinylTex = (base: string, line: string) =>
  canvasTex(
    1024,
    (x, n) => {
      x.fillStyle = base;
      x.fillRect(0, 0, n, n);
      const R = rnd(31);
      for (let i = 0; i < 12000; i++) {
        x.fillStyle = `rgba(255,255,255,${R() * 0.12})`;
        x.fillRect(R() * n, R() * n, 1.5, 1.5);
      }
      x.strokeStyle = line;
      x.lineWidth = 2.5;
      for (let i = 0; i <= 4; i++) {
        x.beginPath();
        x.moveTo((i * n) / 4, 0);
        x.lineTo((i * n) / 4, n);
        x.stroke();
        x.beginPath();
        x.moveTo(0, (i * n) / 4);
        x.lineTo(n, (i * n) / 4);
        x.stroke();
      }
    },
    48,
  );
// 사무 공간 카펫 타일: 결 방향을 바꿔 깐 50cm 타일
const carpetTex = (base: string, dark: string) =>
  canvasTex(
    1024,
    (x, n) => {
      const k = 8;
      const w = n / k;
      for (let i = 0; i < k; i++)
        for (let j = 0; j < k; j++) {
          x.fillStyle = base;
          x.fillRect(i * w, j * w, w, w);
          x.strokeStyle = dark;
          x.globalAlpha = 0.35;
          x.lineWidth = 1.2;
          for (let t = 2; t < w; t += 5) {
            x.beginPath();
            if ((i + j) % 2) {
              x.moveTo(i * w + t, j * w);
              x.lineTo(i * w + t, j * w + w);
            } else {
              x.moveTo(i * w, j * w + t);
              x.lineTo(i * w + w, j * w + t);
            }
            x.stroke();
          }
          x.globalAlpha = 1;
        }
    },
    40,
  );
// 복도 포세린 타일(120cm)
const porcelainTex = () =>
  canvasTex(
    1024,
    (x, n) => {
      const R = rnd(5);
      const k = 4;
      const w = n / k;
      for (let i = 0; i < k; i++)
        for (let j = 0; j < k; j++) {
          const v = 238 + Math.round(R() * 7);
          x.fillStyle = `rgb(${v},${v},${v - 2})`;
          x.fillRect(i * w, j * w, w, w);
        }
      x.strokeStyle = '#d2d5d8';
      x.lineWidth = 3;
      for (let i = 0; i <= k; i++) {
        x.beginPath();
        x.moveTo(i * w, 0);
        x.lineTo(i * w, n);
        x.stroke();
        x.beginPath();
        x.moveTo(0, i * w);
        x.lineTo(n, i * w);
        x.stroke();
      }
    },
    48,
  );
const smallTileTex = () =>
  canvasTex(
    256,
    (x, n) => {
      x.fillStyle = '#dfe7ec';
      x.fillRect(0, 0, n, n);
      x.strokeStyle = '#c3ced5';
      x.lineWidth = 2;
      for (let i = 0; i <= 8; i++) {
        x.beginPath();
        x.moveTo((i * n) / 8, 0);
        x.lineTo((i * n) / 8, n);
        x.stroke();
        x.beginPath();
        x.moveTo(0, (i * n) / 8);
        x.lineTo(n, (i * n) / 8);
        x.stroke();
      }
    },
    16,
  );
const concreteTex = () =>
  canvasTex(
    256,
    (x, n) => {
      x.fillStyle = '#d9d7d2';
      x.fillRect(0, 0, n, n);
      const R = rnd(8);
      for (let i = 0; i < 3000; i++) {
        const v = R() > 0.5 ? 255 : 90;
        x.fillStyle = `rgba(${v},${v},${v},0.05)`;
        x.fillRect(R() * n, R() * n, 2, 2);
      }
    },
    40,
  );

const std = (color: number, roughness = 0.75, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: 0.4, ...extra });

type Materials = ReturnType<typeof createMaterials>;
let materials: Materials | null = null;
function createMaterials() {
  const zone: Record<ZoneKind, THREE.MeshStandardMaterial> = {
    outpatient: std(0xffffff, 0.45, 0, { map: terrazzoTex('#e6dccb', 3) }),
    exam: std(0xffffff, 0.5, 0, {
      map: vinylTex('#cfdcea', ['#b9c9da', '#e4ecf4', '#a9bcd0'], 'rgba(90,110,140,.22)', 21),
    }),
    acute: std(0xffffff, 0.5, 0, {
      map: vinylTex('#cde5d9', ['#b4d3c4', '#e3f1ea', '#9fc5b2'], 'rgba(60,110,90,.22)', 23),
    }),
    family: std(0xffffff, 0.5, 0, {
      map: vinylTex('#dde9c9', ['#c8daae', '#edf4e1', '#b5ca9a'], 'rgba(90,120,60,.2)', 25),
    }),
    surgery: std(0xffffff, 0.4, 0, { map: gridVinylTex('#b8d6d3', 'rgba(40,90,90,.35)') }),
  };
  // 실물 리더 강조 때 나머지 구역을 어둡게 그릴 바닥
  const dimmed = Object.fromEntries(
    Object.entries(zone).map(([k, m]) => [k, std(0x7d8590, 0.6, 0, { map: m.map })]),
  ) as Record<ZoneKind, THREE.MeshStandardMaterial>;
  return {
    corridor: std(0xffffff, 0.3, 0, { map: porcelainTex() }),
    zone,
    dimmed,
    office: std(0xffffff, 0.9, 0, { map: carpetTex('#9aa7b4', '#6f7d8b') }),
    service: std(0xffffff, 0.8, 0, { map: concreteTex() }),
    wcFloor: std(0xffffff, 0.4, 0, { map: smallTileTex() }),
    skirting: {
      outpatient: std(0xb9ab93, 0.5),
      exam: std(0x8fa3b8, 0.5),
      acute: std(0x86ab99, 0.5),
      family: std(0x9db285, 0.5),
      surgery: std(0x6f9895, 0.5),
      office: std(0x5f6b77, 0.6),
      service: std(0xa8a49c, 0.6),
    },
    slabSide: std(0xc9c5bd, 0.9),
    wall: std(0xf6f5f2, 0.85),
    wallOuter: std(0xf1f0ec, 0.8),
    cap: std(0x24282d, 0.7),
    glass: std(0xb8d3e2, 0.05, 0.1, { transparent: true, opacity: 0.32, depthWrite: false }),
    frame: std(0x3b434b, 0.45, 0.4),
    doorLeaf: std(0xd8c7ad, 0.6),
    doorGlass: std(0xc7dde8, 0.05, 0.1, { transparent: true, opacity: 0.4, depthWrite: false }),
    evFloor: std(0xc4cbd2, 0.45, 0.55),
    evDoor: std(0xc9d0d7, 0.35, 0.2),
    evFrame: std(0x8b96a1, 0.4, 0.2),
    stair: std(0xd6d3cd, 0.85),
    stairSide: std(0x7a838c, 0.35, 0.7),
    rail: std(0x9aa6b2, 0.3, 0.8),
    railGlass: std(0xbfd8e6, 0.05, 0.1, { transparent: true, opacity: 0.38, depthWrite: false }),
    inlay: std(0x8a6a4c, 0.6),
    toilet: std(0xfafafa, 0.3),
    stall: std(0x4c5560, 0.6),
    canopy: std(0xf6f6f4, 0.55),
  };
}
const mats = () => (materials ??= createMaterials());

// ── 기하 도우미 ───────────────────────────────────────
const lerp = (a: Px, b: Px, t: number): Px => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const rectPoly = (x1: number, y1: number, x2: number, y2: number): Px[] => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
];
function segDistance(p: Px, a: Px, b: Px) {
  return edgeDistance(p, [a, b]);
}
// 선분 a→b의 안쪽 법선(poly 안을 향함)
function inwardNormal(a: Px, b: Px, poly: Px[]): Px {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n: Px = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  const mid = lerp(a, b, 0.5);
  return contains([mid[0] + n[0] * 3, mid[1] + n[1] * 3], poly) ? n : [-n[0], -n[1]];
}

class Builder {
  readonly root = new THREE.Group();
  constructor(
    private readonly cx: number,
    private readonly cy: number,
  ) {}

  world(x: number, y: number, h = 0) {
    return new THREE.Vector3(x - this.cx, h, y - this.cy);
  }

  // 다각형을 base에서 h만큼 세운다(윗면, 옆면 재질)
  prism(poly: Px[], base: number, h: number, top: THREE.Material, side: THREE.Material = top, cast = false) {
    const shape = new THREE.Shape();
    poly.forEach(([x, y], i) =>
      i ? shape.lineTo(x - this.cx, -(y - this.cy)) : shape.moveTo(x - this.cx, -(y - this.cy)),
    );
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, base, 0);
    const mesh = new THREE.Mesh(g, [top, side]);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    return mesh;
  }

  // a→b 선분 위 높이 y0~y1, 두께 t의 상자
  seg(a: Px, b: Px, y0: number, y1: number, t: number, mat: THREE.Material, cast = true) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 0.4 || y1 - y0 < 0.05) return;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, y1 - y0, t), mat);
    mesh.position.copy(this.world((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (y0 + y1) / 2));
    mesh.rotation.y = -Math.atan2(dy, dx);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    this.root.add(mesh);
  }
}

export type ZonePx = { readerId: string; name: string; poly: Px[] };

export function buildFloorModel(plan: FloorPlan, zones: ZonePx[], dimmedReaderIds: Set<string> | null) {
  const m = mats();
  const [cx, cy] = CENTER;
  const b = new Builder(cx, cy);
  const blocks = [
    ...zones.map((z) => z.poly),
    ...plan.rooms.map((r) => r.poly),
    ...plan.service,
    ...plan.cores.map(([, x1, y1, x2, y2]) => rectPoly(x1, y1, x2, y2)),
  ];
  const isCorridor = (p: Px) => contains(p, plan.outline) && !blocks.some((poly) => contains(p, poly));
  const onOutline = (a: Px, c: Px) => [0.2, 0.5, 0.8].every((t) => edgeDistance(lerp(a, c, t), plan.outline) < 4.5);
  const roomFloor = (r: Room) =>
    r.kind === 'office' || r.kind === 'pharmacy' ? m.office : r.kind === 'waiting' ? m.zone.outpatient : m.zone.exam;

  // 바닥
  b.prism(plan.outline, -SLAB, SLAB, m.corridor, m.slabSide);
  for (const z of zones) {
    const kind = zoneKind(z.name);
    const floor = dimmedReaderIds && !dimmedReaderIds.has(z.readerId) ? m.dimmed[kind] : m.zone[kind];
    b.prism(z.poly, 0, 0.6, floor, m.wall).userData.readerId = z.readerId;
  }
  for (const r of plan.rooms) b.prism(r.poly, 0, 0.6, roomFloor(r), m.wall);
  for (const p of plan.service) b.prism(p, 0, 0.6, m.service, m.wall);

  // 걸레받이(벽 밑 띠)와 바닥 테두리
  const trim = (poly: Px[], skirt: THREE.Material) =>
    poly.forEach((a, i) => {
      const c = poly[(i + 1) % poly.length];
      if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 3) return;
      const n = inwardNormal(a, c, poly);
      const off = (d: number): [Px, Px] => [
        [a[0] + n[0] * d, a[1] + n[1] * d],
        [c[0] + n[0] * d, c[1] + n[1] * d],
      ];
      b.seg(...off(PART_T / 2 + 0.5), 0.6, 1.5, 0.7, skirt, false);
      b.seg(...off(4.2), 0.6, 0.68, 2.2, skirt, false);
    });
  for (const z of zones) trim(z.poly, m.skirting[zoneKind(z.name)]);
  for (const r of plan.rooms) trim(r.poly, roomFloor(r) === m.office ? m.skirting.office : m.skirting.outpatient);
  for (const p of plan.service) trim(p, m.skirting.service);

  // 칸막이 벽과 복도 쪽 문. 같은 선분은 한 번만 세운다
  const seen = new Set<string>();
  const key = (a: Px, c: Px) => {
    const k1 = `${Math.round(a[0] / 2)},${Math.round(a[1] / 2)}`;
    const k2 = `${Math.round(c[0] / 2)},${Math.round(c[1] / 2)}`;
    return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
  };
  const wallPoly = (poly: Px[], glassFront = false) =>
    poly.forEach((a, i) => {
      const c = poly[(i + 1) % poly.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 1 || onOutline(a, c)) return;
      const k = key(a, c);
      const dup = seen.has(k);
      seen.add(k);
      const n = inwardNormal(a, c, poly);
      const outside = (t: number): Px => {
        const p = lerp(a, c, t);
        return [p[0] - n[0] * 5, p[1] - n[1] * 5];
      };
      const corridorSide = isCorridor(outside(0.5)) && isCorridor(outside(0.3));
      const doors = corridorSide && len >= 26 ? (len >= 170 ? [0.28, 0.72] : [len > 60 ? 0.3 : 0.5]) : [];
      const hw = DOOR / 2 / len;
      if (!dup) {
        let s0 = 0;
        const solid = (u: number, v: number) => {
          if (v - u <= 0) return;
          if (glassFront && corridorSide) {
            b.seg(lerp(a, c, u), lerp(a, c, v), 0.6, 1.6, PART_T, m.frame);
            b.seg(lerp(a, c, u), lerp(a, c, v), 1.6, HEAD, 0.6, m.doorGlass, false);
            b.seg(lerp(a, c, u), lerp(a, c, v), HEAD, WALL, PART_T, m.wall);
          } else b.seg(lerp(a, c, u), lerp(a, c, v), 0, WALL, PART_T, m.wall);
        };
        for (const t of doors) {
          solid(s0, t - hw);
          s0 = t + hw;
          b.seg(lerp(a, c, t - hw), lerp(a, c, t + hw), DOOR_H, WALL, PART_T, m.wall);
          // 70° 열린 문짝
          const hinge = lerp(a, c, t - hw);
          const dir: Px = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
          const ang = 1.2;
          const end: Px = [
            hinge[0] + (dir[0] * Math.cos(ang) + n[0] * Math.sin(ang)) * DOOR,
            hinge[1] + (dir[1] * Math.cos(ang) + n[1] * Math.sin(ang)) * DOOR,
          ];
          b.seg(hinge, end, 0.6, DOOR_H - 0.4, 0.8, glassFront ? m.doorGlass : m.doorLeaf);
        }
        solid(s0, 1);
        b.seg(a, c, WALL, WALL + 0.5, PART_T + 0.3, m.cap, false);
      }
    });
  for (const z of zones) wallPoly(z.poly);
  for (const r of plan.rooms) wallPoly(r.poly, r.kind === 'office' || r.kind === 'pharmacy');
  for (const p of plan.service) wallPoly(p);
  for (const w of plan.walls)
    for (let i = 0; i < w.length - 1; i++) {
      if (onOutline(w[i], w[i + 1])) continue;
      b.seg(w[i], w[i + 1], 0, WALL * 0.55, PART_T, m.wall);
      b.seg(w[i], w[i + 1], WALL * 0.55, WALL * 0.55 + 0.5, PART_T + 0.3, m.cap, false);
    }

  // 외벽: 둘레를 따라 일정 간격의 창, 1층 출입구는 유리문과 캐노피
  const gates = plan.labels.filter((l) => l.kind === 'gate').map((l) => l.at);
  let perimeter = 0;
  plan.outline.forEach((a, i) => {
    const c = plan.outline[(i + 1) % plan.outline.length];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (len < 0.5) return;
    const at = (d: number) => lerp(a, c, d / len);
    const gateSpans: [number, number][] = [];
    for (const g of gates) {
      if (segDistance(g, a, c) > 26 || len <= GATE + 2) continue;
      const along = ((g[0] - a[0]) * (c[0] - a[0]) + (g[1] - a[1]) * (c[1] - a[1])) / len;
      const mid = Math.max(GATE / 2 + 1, Math.min(len - GATE / 2 - 1, along));
      gateSpans.push([mid - GATE / 2, mid + GATE / 2]);
    }
    const windows: [number, number][] = [];
    for (let k = Math.floor(perimeter / WINDOW_PERIOD) - 1; ; k++) {
      const mid = k * WINDOW_PERIOD + WINDOW_PERIOD / 2 - perimeter;
      if (mid - WINDOW / 2 > len) break;
      if (mid - WINDOW / 2 - 4 < 0 || mid + WINDOW / 2 + 4 > len) continue;
      if (gateSpans.some(([u, v]) => mid + WINDOW / 2 > u - 4 && mid - WINDOW / 2 < v + 4)) continue;
      windows.push([mid - WINDOW / 2, mid + WINDOW / 2]);
    }
    perimeter += len;
    const holes = [
      ...windows.map(([u, v]) => [u, v, 0] as const),
      ...gateSpans.map(([u, v]) => [u, v, 1] as const),
    ].sort((p, q) => p[0] - q[0]);
    let s0 = 0;
    for (const [u, v] of holes) {
      if (u - s0 > 0.1) b.seg(at(s0), at(u), 0, WALL, OUTER_T, m.wallOuter);
      s0 = v;
    }
    if (len - s0 > 0.1) b.seg(at(s0), at(len), 0, WALL, OUTER_T, m.wallOuter);
    b.seg(a, c, WALL, WALL + 0.6, OUTER_T + 0.4, m.cap, false);
    for (const [u, v, isGate] of holes) {
      const g0 = at(u);
      const g1 = at(v);
      b.seg(g0, g1, HEAD, WALL, OUTER_T, m.wallOuter);
      if (!isGate) {
        b.seg(g0, g1, 0, SILL, OUTER_T, m.wallOuter);
        b.seg(g0, g1, SILL, HEAD, 0.6, m.glass, false);
        b.seg(g0, g1, SILL - 0.4, SILL + 0.6, OUTER_T + 0.6, m.frame);
        b.seg(g0, g1, HEAD - 0.6, HEAD + 0.2, OUTER_T + 0.4, m.frame);
        for (const e of [u, v]) b.seg(at(e - 0.5), at(e + 0.5), SILL, HEAD, OUTER_T + 0.4, m.frame);
        b.seg(at((u + v) / 2 - 0.4), at((u + v) / 2 + 0.4), SILL, HEAD, 1.2, m.frame);
      } else {
        b.seg(g0, g1, 0, HEAD, 1.2, m.doorGlass, false);
        b.seg(g0, g1, HEAD - 0.5, HEAD + 0.7, OUTER_T + 1.2, m.frame);
        for (const e of [u, (u + v) / 2, v]) b.seg(at(e - 0.5), at(e + 0.5), 0, HEAD, OUTER_T + 1.2, m.frame);
        const out = inwardNormal(a, c, plan.outline);
        const c0 = at(u - 6);
        const c1 = at(v + 6);
        b.seg(
          [c0[0] - out[0] * 9, c0[1] - out[1] * 9],
          [c1[0] - out[0] * 9, c1[1] - out[1] * 9],
          HEAD + 1,
          HEAD + 2.2,
          18,
          m.canopy,
        );
      }
    }
  });

  // 수직 동선
  for (const [kind, x1, y1, x2, y2] of plan.cores) {
    const rect = rectPoly(x1, y1, x2, y2);
    if (kind === 'EV') {
      // 금속 바닥 + 밝은 벽(윗선만 검게) + 복도 쪽 은색 미닫이 문
      b.prism(rect, 0, 0.7, m.evFloor, m.wall);
      rect.forEach((a, i) => {
        const c = rect[(i + 1) % 4];
        const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
        const n = inwardNormal(a, c, rect);
        const mid = lerp(a, c, 0.5);
        const k = key(a, c);
        const dup = seen.has(k);
        seen.add(k);
        const front = isCorridor([mid[0] - n[0] * 4, mid[1] - n[1] * 4]);
        const hw = front ? Math.min(4.5, len * 0.32) / len : 0;
        if (!dup) {
          if (front) {
            b.seg(a, lerp(a, c, 0.5 - hw), 0, WALL, PART_T, m.wall);
            b.seg(lerp(a, c, 0.5 + hw), c, 0, WALL, PART_T, m.wall);
            b.seg(lerp(a, c, 0.5 - hw), lerp(a, c, 0.5 + hw), DOOR_H, WALL, PART_T, m.wall);
          } else b.seg(a, c, 0, WALL, PART_T, m.wall);
          b.seg(a, c, WALL, WALL + 0.5, PART_T + 0.3, m.cap, false);
        }
        if (front) {
          const off = (p: Px): Px => [p[0] - n[0] * 0.2, p[1] - n[1] * 0.2];
          b.seg(off(lerp(a, c, 0.5 - hw)), off(mid), 0.6, DOOR_H, 0.9, m.evDoor);
          b.seg(off(mid), off(lerp(a, c, 0.5 + hw)), 0.6, DOOR_H, 0.9, m.evDoor);
          b.seg(
            lerp(a, c, 0.5 - hw - 0.4 / len),
            lerp(a, c, 0.5 + hw + 0.4 / len),
            DOOR_H,
            DOOR_H + 1.4,
            PART_T + 0.8,
            m.evFrame,
          );
        }
      });
    } else if (kind === 'WC') {
      b.prism(rect, 0, 0.7, m.wcFloor, m.wall);
      wallPoly(rect);
      const w = x2 - x1;
      const h = y2 - y1;
      const along = w >= h;
      const n: Px = along ? [0, 1] : [1, 0];
      const back: [Px, Px] = along
        ? [
            [x1 + 3, y1 + 3],
            [x2 - 3, y1 + 3],
          ]
        : [
            [x1 + 3, y1 + 3],
            [x1 + 3, y2 - 3],
          ];
      const len = Math.hypot(back[1][0] - back[0][0], back[1][1] - back[0][1]);
      const count = Math.max(1, Math.floor(len / 9));
      for (let k = 0; k < count; k++) {
        const p = lerp(back[0], back[1], (k + 0.5) / count);
        const toilet = new THREE.Group();
        toilet.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.42, 0.6), m.toilet).translateY(0.21).translateZ(0.05));
        toilet.add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.18), m.toilet).translateY(0.55).translateZ(-0.22));
        toilet.scale.setScalar(10);
        toilet.position.copy(b.world(p[0] + n[0] * 2, p[1] + n[1] * 2, 0.7));
        toilet.rotation.y = Math.atan2(n[0], n[1]);
        b.root.add(toilet);
        if (k > 0) {
          const q = lerp(back[0], back[1], k / count);
          b.seg(q, [q[0] + n[0] * 13, q[1] + n[1] * 13], 0.6, 17, 0.6, m.stall);
        }
      }
    } else {
      const w = x2 - x1;
      const h = y2 - y1;
      const along = w > h;
      const steps = Math.max(5, Math.round((along ? w : h) / 3.2));
      for (let i = 0; i < steps; i++) {
        const a0 = i / steps;
        const a1 = (i + 1) / steps;
        const step = along ? rectPoly(x1 + w * a0, y1, x1 + w * a1, y2) : rectPoly(x1, y1 + h * a0, x2, y1 + h * a1);
        const rise = kind === 'ES' ? 1 + (1 - a0) * 9 : 1 + a0 * (WALL - 4);
        b.prism(step, 0, rise, m.stair, m.stairSide, true);
      }
      const rails: [Px, Px][] = along
        ? [
            [
              [x1, y1 + 0.5],
              [x2, y1 + 0.5],
            ],
            [
              [x1, y2 - 0.5],
              [x2, y2 - 0.5],
            ],
          ]
        : [
            [
              [x1 + 0.5, y1],
              [x1 + 0.5, y2],
            ],
            [
              [x2 - 0.5, y1],
              [x2 - 0.5, y2],
            ],
          ];
      for (const [p, q] of rails)
        b.seg(p, q, 0, kind === 'ES' ? 10 : 5, kind === 'ES' ? 0.8 : 0.6, kind === 'ES' ? m.railGlass : m.rail, false);
    }
  }

  // 개방부: 2층 이상은 유리 난간, 1층은 바닥 띠
  for (const r of plan.railings)
    for (let i = 0; i < r.length - 1; i++) {
      if (plan.floor >= 2) {
        b.seg(r[i], r[i + 1], 0.6, 9, 0.6, m.railGlass, false);
        b.seg(r[i], r[i + 1], 9, 9.8, 1.0, m.rail);
      } else b.seg(r[i], r[i + 1], 0, 0.9, 2.4, m.inlay);
    }

  // 리더 구역 이름은 바닥에 새긴다 — 장비가 있을 수 없는 실·편의시설·출입구 이름은 넣지 않는다
  const names = new THREE.Group();
  for (const z of zones) {
    const label = plan.zoneLabels[z.readerId];
    if (!label) continue;
    const mesh = floorText(label.lines, floorTextLayout(z.poly, label.lines));
    mesh.position.copy(b.world(label.at[0], label.at[1], 0.65));
    names.add(mesh);
  }
  b.root.add(names);

  const fitPoints = plan.outline.flatMap(([x, y]) => [b.world(x, y, -SLAB), b.world(x, y, WALL + 1)]);
  return { group: b.root, names, fitPoints };
}

const TEXT_INK = '#0f2e4f';
const TEXT_HALO = 'rgba(255,255,255,0.9)';
const TEXT_RES = 10; // 바닥 1px당 텍스처 픽셀
const TEXT_MAX_CANVAS = 2048;

// 구역 이름판. layout(평면 각도·글자 크기)은 장비 배치가 피해 가는 사각형과 같다
function floorText(lines: string[], { angle, size }: { angle: number; size: number }) {
  const box = floorTextBox(lines, size);
  // 흰 테두리가 글자 밖으로 나오는 만큼 판을 넓힌다(장비는 이름에서 26px 떨어지므로 겹치지 않는다)
  const pad = size * 0.12;
  const w = box.width + pad * 2;
  const h = box.height + pad * 2;
  const k = Math.min(TEXT_RES, TEXT_MAX_CANVAS / w);
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * k);
  c.height = Math.ceil(h * k);
  const x = c.getContext('2d');
  if (x) {
    const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
    let font = size * k;
    x.font = `800 ${font}px ${family}`;
    // 실제 글꼴이 추정 폭보다 넓으면 줄여 사각형 안에 둔다
    const widest = Math.max(...lines.map((l) => x.measureText(l).width));
    if (widest > box.width * k) font *= (box.width * k) / widest;
    x.font = `800 ${font}px ${family}`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.lineJoin = 'round';
    x.lineWidth = font * 0.2;
    x.strokeStyle = TEXT_HALO;
    x.fillStyle = TEXT_INK;
    lines.forEach((l, i) => {
      const y = (pad + (i + 0.5) * (box.height / lines.length)) * k;
      x.strokeText(l, c.width / 2, y);
      x.fillText(l, c.width / 2, y);
    });
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const material = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // 평면의 위쪽(+Y)이 북쪽(-Z)을 보도록 눕힌 뒤, 기준선을 평면 각도로 돌린다
  const geometry = new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.y = -angle;
  mesh.userData.ownsMaterial = true;
  return mesh;
}

// ── 장비 자리 ─────────────────────────────────────────
type EquipmentInput = { tag_id: string; reader_id: string; label: string; assetStatus?: string };
export type PlacedEquipment = EquipmentInput & { position: THREE.Vector3 };

// 구역 안 장비 자리(바닥 높이). 3D 보기는 장비를 2D 지도처럼 점과 이름표로만 그린다
export function placeEquipmentOnFloor(
  plan: FloorPlan,
  zones: ZonePx[],
  equipment: EquipmentInput[],
): PlacedEquipment[] {
  const [cx, cy] = CENTER;
  const placed: PlacedEquipment[] = [];
  for (const z of zones) {
    const inZone = equipment.filter((e) => e.reader_id === z.readerId);
    if (!inZone.length) continue;
    const { spots } = placeEquipment(
      z.poly,
      inZone.map((e) => e.tag_id),
      plan.zoneLabels[z.readerId],
    );
    for (const e of inZone) {
      const [x, y] = spots.get(e.tag_id)!;
      placed.push({ ...e, position: new THREE.Vector3(x - cx, 0.6, y - cy) });
    }
  }
  return placed;
}

// 층 모형을 바꿀 때 geometry를 해제한다. 공유 재질은 두고, 메쉬마다 만든 재질(ownsMaterial: 구역 이름판)만 텍스처와 함께 해제한다
export function disposeGeometries(object: THREE.Object3D) {
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    if (mesh.userData.ownsMaterial) {
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
    }
  });
}

// 구역 안내에서 고른 점(퍼센트)을 바닥 좌표로
export function highlightPosition(mapX: number, mapY: number) {
  return new THREE.Vector3((mapX * 930) / 100 - CENTER[0], 1, (mapY * 976) / 100 - CENTER[1]);
}
