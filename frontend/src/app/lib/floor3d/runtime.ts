// 3D 지도 실행 중 판단(three.js 없이 계산만): 장비 이름표 비킴, 장비 층 갱신 여부, 품질 자동 조절.
export type Rect = { left: number; top: number; right: number; bottom: number };

type TagDot = { id: string; x: number; y: number; w: number; h: number };
// 이름표 중심. moved: 점 바로 위 기본 자리를 비켜 났는가
export type TagSpot = { x: number; y: number; moved: boolean };
const DOT_R = 7; // 2D 지도 점(14px)의 반지름
const DOT_GAP = 4;
const TAG_GAP = 2;
const BELOW_PENALTY = 4; // 점 아래는 위보다 이만큼 덜 선호

const overlaps = (a: Rect, b: Rect) =>
  a.right > b.left - TAG_GAP && a.left < b.right + TAG_GAP && a.bottom > b.top - TAG_GAP && a.top < b.bottom + TAG_GAP;

/**
 * 장비 점 바로 위에 이름표를 놓는다. dots의 x, y는 점 중심, w, h는 이름표 크기.
 * 다른 이름표나 점을 덮거나 화면 밖이면 비킨다. 후보는 점 바로 위·바로 아래를 기준으로 위아래 한 줄·좌우 반 칸씩 비킨 격자이고,
 * 두 기준 중 가까운 쪽까지의 거리 순으로 본다(아래는 조금 덜 선호). 비킨 이름표로 가는 선이 다른 이름표나 점을 지나지 않는 자리를 먼저 찾고,
 * 없으면 겹치지만 않는 자리, 그것도 없으면 기본 자리. 목록 앞의 점이 먼저 자리를 잡는다(고른 장비를 맨 앞에 둔다).
 */
export function placeTagLabels(dots: TagDot[], view: Rect): Map<string, TagSpot> {
  const out = new Map<string, TagSpot>();
  const taken: Rect[] = dots.map((d) => ({
    left: d.x - DOT_R,
    top: d.y - DOT_R,
    right: d.x + DOT_R,
    bottom: d.y + DOT_R,
  }));
  dots.forEach((d, i) => {
    const above = d.y - DOT_R - DOT_GAP - d.h / 2;
    const below = d.y + DOT_R + DOT_GAP + d.h / 2;
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
