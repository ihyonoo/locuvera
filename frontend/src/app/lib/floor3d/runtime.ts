// 3D 지도 실행 중 판단(three.js 없이 계산만): 장비 이름표 비킴·색, 구슬 크기·색, 장비 층 갱신 여부, 품질 자동 조절.
import { pinDiameter } from '../mapPins';

export type Rect = { left: number; top: number; right: number; bottom: number };

// r: 점(구슬)의 현재 화면 반지름 — 핀이 지도와 함께 커지고 작아지므로 점마다 다르다
type TagDot = { id: string; x: number; y: number; w: number; h: number; r: number };
// 이름표 중심. moved: 점 바로 위 기본 자리를 비켜 났는가
export type TagSpot = { x: number; y: number; moved: boolean };
const DOT_GAP = 4;
const TAG_GAP = 2;
const BELOW_PENALTY = 4; // 점 아래는 위보다 이만큼 덜 선호

const overlaps = (a: Rect, b: Rect) =>
  a.right > b.left - TAG_GAP && a.left < b.right + TAG_GAP && a.bottom > b.top - TAG_GAP && a.top < b.bottom + TAG_GAP;

// 장비 점 바로 위에 이름표를 놓는다. dots의 x, y는 점 중심, w, h는 이름표 크기
// - 다른 이름표나 점을 덮거나 화면 밖이면 비킨다
// - 후보: 점 바로 위·바로 아래 기준으로 위아래 한 줄·좌우 반 칸씩 비킨 격자. 가까운 기준까지의 거리 순(아래는 조금 덜 선호)
// - 비킨 선이 다른 이름표·점을 지나지 않는 자리 → 겹치지만 않는 자리 → 기본 자리 순으로 고른다
// - 목록 앞의 점이 먼저 자리를 잡는다(고른 장비를 맨 앞에 둔다)
export function placeTagLabels(dots: TagDot[], view: Rect): Map<string, TagSpot> {
  const out = new Map<string, TagSpot>();
  const taken: Rect[] = dots.map((d) => ({
    left: d.x - d.r,
    top: d.y - d.r,
    right: d.x + d.r,
    bottom: d.y + d.r,
  }));
  dots.forEach((d, i) => {
    const above = d.y - d.r - DOT_GAP - d.h / 2;
    const below = d.y + d.r + DOT_GAP + d.h / 2;
    const step = d.h + TAG_GAP;
    const half = d.w / 2 + TAG_GAP;
    const spots: { x: number; y: number; cost: number }[] = [];
    for (const base of [above, below])
      for (let row = -6; row <= 6; row++)
        for (let col = -4; col <= 4; col++) {
          const [x, y] = [d.x + col * half, base + row * step];
          spots.push({
            x,
            y,
            cost: Math.min(Math.hypot(x - d.x, y - above), Math.hypot(x - d.x, y - below) + BELOW_PENALTY),
          });
        }
    spots.sort((a, b) => a.cost - b.cost);
    const rectAt = ({ x, y }: { x: number; y: number }) => ({
      left: x - d.w / 2,
      top: y - d.h / 2,
      right: x + d.w / 2,
      bottom: y + d.h / 2,
    });
    const open = spots.filter((p) => {
      const r = rectAt(p);
      return (
        r.left >= view.left &&
        r.right <= view.right &&
        r.top >= view.top &&
        r.bottom <= view.bottom &&
        !taken.some((o) => overlaps(r, o))
      );
    });
    // 자기 점은 선의 출발점이라 뺀다
    const others = taken.filter((_, k) => k !== i);
    const clear = open.find((p) => p === spots[0] || !others.some((o) => segmentThrough([d.x, d.y], [p.x, p.y], o)));
    const spot = clear ?? open[0] ?? spots[0];
    taken.push(rectAt(spot));
    out.set(d.id, { x: spot.x, y: spot.y, moved: spot !== spots[0] });
  });
  return out;
}

// 선분이 사각형 안쪽을 지나는가. 사각형 안쪽으로 잘라 남는 길이가 있는지 본다
function segmentThrough([ax, ay]: [number, number], [bx, by]: [number, number], r: Rect) {
  const [dx, dy] = [bx - ax, by - ay];
  let [t0, t1] = [0, 1];
  for (const [p, q] of [
    [-dx, ax - r.left],
    [dx, r.right - ax],
    [-dy, ay - r.top],
    [dy, r.bottom - ay],
  ]) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

const NAVY = '#0f2e4f';
// 상태별 글씨 색: 핀과 같은 계열에서 칩 바탕 대비 4.5:1을 넘는 색. 비활성은 본문색
// 라이트: 흰 칩 / 다크: 어두운 칩(--card #1a1b1e)에 밝은 상태 색, 본문색 #e7e8ea
const STATUS_TEXT: Record<string, string> = { available: '#15803d', checked_out: '#dc2626' };
const STATUS_TEXT_DARK: Record<string, string> = { available: '#4ade80', checked_out: '#f87171' };
const DARK_CHIP = '#1a1b1e';
const DARK_TEXT = '#e7e8ea';

// 이름표 바탕·글씨 색. 고른 장비는 바탕과 글씨를 뒤집어 눈에 띄게 하고, 나머지는 칩 위에 상태 색 글씨.
// 상태가 없으면 점처럼 사용 가능으로 본다
export function tagColors(
  assetStatus: string | undefined,
  focused: boolean,
  dark = false,
): { background: string; color: string } {
  const status = assetStatus ?? 'available';
  if (dark) {
    if (focused) return { background: DARK_TEXT, color: NAVY };
    return { background: DARK_CHIP, color: STATUS_TEXT_DARK[status] ?? DARK_TEXT };
  }
  if (focused) return { background: NAVY, color: '#fff' };
  return { background: '#fff', color: STATUS_TEXT[status] ?? NAVY };
}

// 원근 카메라에서 화면 1px이 그 깊이(카메라 앞 방향 거리)의 장면 단위로 얼마인가
// 구슬의 장면 지름과 화면 px 사이를 바꿀 때 쓴다
export function worldPerPixel(depth: number, fovDeg: number, viewportHeight: number): number {
  return (2 * depth * Math.tan((fovDeg * Math.PI) / 360)) / viewportHeight;
}

type LayerDot = { tag_id: string; reader_id: string; assetStatus?: string };

// 1초마다 오는 데이터 중 장비 층을 다시 그려야 하는 변화만 키에 담는다
export function equipmentLayerKey(dots: LayerDot[]): string {
  return dots
    .map((d) => `${d.tag_id}:${d.reader_id}:${d.assetStatus ?? ''}`)
    .sort()
    .join('|');
}

// 0 전체 품질 → 1 음영(GTAO) 끔 → 2 그림자 끔 → 3 픽셀 배율 1
export type QualityLevel = 0 | 1 | 2 | 3;
const WARMUP_FRAMES = 10;
const WINDOW_FRAMES = 60;
const SLOW_FRAME_MS = 33;

export function createQualityGovernor() {
  let level: QualityLevel = 0;
  let warmup = WARMUP_FRAMES;
  let total = 0;
  let count = 0;
  return {
    get level() {
      return level;
    },
    // 프레임 시간을 받아, 단계를 내려야 하면 새 단계를 돌려준다(올리지는 않는다)
    record(frameMs: number): QualityLevel | null {
      if (warmup > 0) {
        warmup -= 1;
        return null;
      }
      if (level === 3) return null;
      total += frameMs;
      count += 1;
      if (count < WINDOW_FRAMES) return null;
      const slow = total / count > SLOW_FRAME_MS;
      total = 0;
      count = 0;
      if (!slow) return null;
      level = (level + 1) as QualityLevel;
      return level;
    },
  };
}

// 처음 화면(층 전체)에서 지도 상자 폭의 2%인 핀 지름을 장면 길이로 바꾼다
// fitWorldPerPixel: 그때 목표점 깊이에서 화면 1px의 장면 길이
export function pinWorldDiameter(mapWidthPx: number, fitWorldPerPixel: number): number {
  return pinDiameter(mapWidthPx) * fitWorldPerPixel;
}

// 장면 속 지름이 지금 화면에서 몇 px인가
export function pinScreenDiameter(worldDiameter: number, worldPerPx: number): number {
  return worldDiameter / worldPerPx;
}

// three의 ACESFilmicToneMapping이 쓰는 행렬(셰이더의 열 우선 mat3를 행 기준으로 옮겼다)
const ACES_INPUT = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const ACES_OUTPUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

function solve3(m: number[][], v: number[]): number[] {
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  // 크라메르 공식
  return [0, 1, 2].map((col) => det(m.map((row, i) => row.map((x, j) => (j === col ? v[i] : x)))) / d);
}

// RRTAndODTFit(v) = (v² + 0.0245786v − 0.000090537) / (0.983729v² + 0.432951v + 0.238081)의 역함수(양의 근)
function invertAcesFit(y: number): number {
  const a = 1 - 0.983729 * y;
  const b = 0.0245786 - 0.432951 * y;
  const c = -(0.000090537 + 0.238081 * y);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

// 마지막 OutputPass가 화면 전체에 ACES 톤 매핑을 걸어 3D 구슬 색이 바랜다(재질의 toneMapped로는 못 막는다)
// 톤 매핑 뒤 hex가 그대로 나오도록 재질에 넣을 선형 입력색을 거꾸로 구한다
export function acesFilmicInverse(hex: string, exposure = 1): [number, number, number] {
  const target = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const fitted = solve3(ACES_OUTPUT, target).map(invertAcesFit);
  return solve3(ACES_INPUT, fitted).map((x) => (x * 0.6) / exposure) as [number, number, number];
}
