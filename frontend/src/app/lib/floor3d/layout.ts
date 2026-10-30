// 3D 층 지도의 배치 규칙(three.js 없이 계산만). 좌표는 원본 안내도 이미지 px.
export type Px = [number, number];
export type ZoneLabelSpot = { at: Px; lines: string[] };

export type ZoneKind = 'outpatient' | 'exam' | 'acute' | 'family' | 'surgery';

// 위에서부터 먼저 맞는 규칙을 쓴다
const ZONE_KIND_RULES: [ZoneKind, RegExp][] = [
  ['surgery', /수술/],
  ['acute', /응급|중환자|CCU|MICU|심뇌혈관/],
  ['family', /소아|모자|분만|여성/],
  ['exam', /검사|영상|진단|채혈|병리|내시경|투석|신장/],
];

export function zoneKind(name: string): ZoneKind {
  return ZONE_KIND_RULES.find(([, rule]) => rule.test(name))?.[0] ?? 'outpatient';
}

// ── 바닥에 새기는 구역 이름 ───────────────────────────
const TEXT_MIN = 7;
const TEXT_MAX = 28;
const TEXT_FLAT_MIN = 11; // 동서로 써서 이 크기 이상이면 돌리지 않는다
const TEXT_FILL = 0.8;
const TEXT_LINE = 1.25;

// 글자 폭 단위: 한글 1, 영문·숫자 0.6
const textUnits = (line: string) => [...line].reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? 0.6 : 1), 0);

function extentAlong(poly: Px[], [dx, dy]: Px) {
  const proj = poly.map(([x, y]) => x * dx + y * dy);
  return Math.max(...proj) - Math.min(...proj);
}

function fitTextSize(poly: Px[], angle: number, lines: string[]) {
  const along: Px = [Math.cos(angle), Math.sin(angle)];
  const across: Px = [-Math.sin(angle), Math.cos(angle)];
  const width = (extentAlong(poly, along) * TEXT_FILL) / Math.max(...lines.map(textUnits));
  const height = (extentAlong(poly, across) * TEXT_FILL) / (lines.length * TEXT_LINE);
  return Math.min(TEXT_MAX, width, height);
}

/**
 * 구역 바닥에 새길 이름의 방향(평면 좌표 기준선 각도)과 글자 크기(px).
 * 동서로 읽기 좋게 들어가면 그대로, 아니면 긴 벽을 따라 돌린다. 글자 머리는 남서쪽 카메라 반대편(북동)을 향한다.
 */
export function floorTextLayout(poly: Px[], lines: string[]): { angle: number; size: number } {
  const flat = fitTextSize(poly, 0, lines);
  if (flat >= TEXT_FLAT_MIN) return { angle: 0, size: flat };
  let longest = { len: 0, angle: 0 };
  poly.forEach(([x0, y0], i) => {
    const [x1, y1] = poly[(i + 1) % poly.length];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len > longest.len) longest = { len, angle: Math.atan2(y1 - y0, x1 - x0) };
  });
  let angle = longest.angle;
  if (Math.sin(angle) + Math.cos(angle) <= 0) angle += Math.PI;
  const along = fitTextSize(poly, angle, lines);
  return along > flat ? { angle, size: Math.max(TEXT_MIN, along) } : { angle: 0, size: Math.max(TEXT_MIN, flat) };
}

// 새긴 이름이 차지하는 사각형의 크기(바닥 px)
export function floorTextBox(lines: string[], size: number) {
  return { width: size * Math.max(...lines.map(textUnits)), height: size * lines.length * TEXT_LINE };
}

// 새긴 이름이 차지하는 사각형에서 점까지의 거리
export function distanceToFloorText([px, py]: Px, at: Px, lines: string[], layout: { angle: number; size: number }) {
  const box = floorTextBox(lines, layout.size);
  const halfW = box.width / 2;
  const halfH = box.height / 2;
  const dx = px - at[0];
  const dy = py - at[1];
  const u = dx * Math.cos(layout.angle) + dy * Math.sin(layout.angle);
  const v = -dx * Math.sin(layout.angle) + dy * Math.cos(layout.angle);
  return Math.hypot(Math.max(Math.abs(u) - halfW, 0), Math.max(Math.abs(v) - halfH, 0));
}

// ── 장비 자리 ─────────────────────────────────────────
const EDGE_MARGIN = 34;
const SPACING = 82;
const SCALES = [1, 0.85, 0.72, 0.61, 0.52, 0.45];
const GRID = 5;
// 바닥에 새긴 구역 이름에서 장비를 이만큼 띄운다
const TEXT_KEEP_OUT = 26;

export function contains([x, y]: Px, poly: Px[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

export function edgeDistance([px, py]: Px, poly: Px[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return best;
}

export function centroid(poly: Px[]): Px {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const f = x0 * y1 - x1 * y0;
    area += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  return area ? [cx / (3 * area), cy / (3 * area)] : poly[0];
}

type Candidate = { p: Px; score: number };

type KeepOut = { label: ZoneLabelSpot; text: { angle: number; size: number } } | null;

// 구역 안 격자점을, 기준점(이름 근처 또는 중심)에 가깝고 벽에서 먼 순으로 정렬한다. 새긴 이름 위는 뺀다
function candidates(poly: Px[], margin: number, keepOut: KeepOut): Candidate[] {
  const label = keepOut?.label;
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const anchor: Px = label ? [label.at[0] + 6, label.at[1] + 62] : centroid(poly);
  const out: Candidate[] = [];
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += GRID) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += GRID) {
      const p: Px = [x, y];
      if (!contains(p, poly)) continue;
      const edge = edgeDistance(p, poly);
      if (edge < margin) continue;
      if (keepOut && distanceToFloorText(p, keepOut.label.at, keepOut.label.lines, keepOut.text) < TEXT_KEEP_OUT)
        continue;
      const score = Math.hypot(x - anchor[0], y - anchor[1]) - edge * 0.6;
      out.push({ p, score });
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

function pickSpaced(cands: Candidate[], count: number, spacing: number): Px[] {
  const picked: Px[] = [];
  for (const { p } of cands) {
    if (picked.length === count) break;
    if (picked.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= spacing)) picked.push(p);
  }
  return picked;
}

// 간격을 못 지킬 때: 이미 고른 자리에서 가장 먼 후보부터 채운다(겹칠 수 있음)
function fillFarthest(cands: Candidate[], picked: Px[], count: number, poly: Px[]): Px[] {
  const pool = cands.length ? cands.map((c) => c.p) : [centroid(poly)];
  const out = [...picked];
  while (out.length < count) {
    let best = pool[0];
    let bestD = -1;
    for (const p of pool) {
      const d = out.length ? Math.min(...out.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))) : 0;
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
    out.push(best);
  }
  return out;
}

/**
 * 구역 장비의 자리와 그 구역 배율. tag_id 정렬 순으로 자리를 배정하므로 같은 장비 집합은 늘 같은 자리다.
 * 다 들어가지 않으면 배율을 0.45까지 줄이고, 그래도 안 되면 간격 없이 전부 세운다.
 */
export function placeEquipment(
  polygon: Px[],
  tagIds: string[],
  label?: ZoneLabelSpot,
): { spots: Map<string, Px>; scale: number } {
  const ids = [...tagIds].sort();
  const assign = (points: Px[], scale: number) => ({
    spots: new Map(ids.map((id, i) => [id, points[i]] as const)),
    scale,
  });
  const keepOut: KeepOut = label ? { label, text: floorTextLayout(polygon, label.lines) } : null;
  let last: { cands: Candidate[]; picked: Px[] } = { cands: [], picked: [] };
  for (const scale of SCALES) {
    const cands = candidates(polygon, EDGE_MARGIN * scale, keepOut);
    const picked = pickSpaced(cands, ids.length, SPACING * scale);
    if (picked.length === ids.length) return assign(picked, scale);
    // 너무 좁아 이름을 피할 자리가 없으면 마지막에만 그 제한을 푼다(전부 세우기가 우선)
    const fallback = cands.length ? cands : candidates(polygon, 0, keepOut);
    last = { cands: fallback.length ? fallback : candidates(polygon, 0, null), picked };
  }
  return assign(fillFarthest(last.cands, last.picked, ids.length, polygon), SCALES[SCALES.length - 1]);
}
