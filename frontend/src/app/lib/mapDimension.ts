// 층 지도를 2D(안내도 이미지)로 볼지 3D로 볼지와 그 기억.
export type MapDimension = '2d' | '3d';

// 문제가 생기면 이 값만 '2d'로 바꿔 기본 보기를 되돌린다.
export const DEFAULT_MAP_DIMENSION: MapDimension = '3d';
export const MAP_DIMENSION_STORAGE_KEY = 'locuvera.mapDimension';
// 3D 칸 비율. 비스듬한 시점이라 층이 가로로 넓게 보여 2D 이미지 비율(930:976)보다 납작하게 둔다
export const MAP_3D_ASPECT = '4 / 3';

// jsdom처럼 WebGL 전역이 없으면 캔버스를 만들지 않는다 — jsdom의 getContext는 콘솔 오류를 낸다.
export function isWebGLAvailable(): boolean {
  if (typeof WebGLRenderingContext === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    // 확인용 컨텍스트는 바로 놓아, 브라우저의 동시 컨텍스트 한도에 남지 않게 한다
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return Boolean(gl);
  } catch {
    return false;
  }
}

export function readMapDimension(storage: Pick<Storage, 'getItem'> | null, webglAvailable: boolean): MapDimension {
  if (!webglAvailable) return '2d';
  try {
    const stored = storage?.getItem(MAP_DIMENSION_STORAGE_KEY);
    return stored === '2d' || stored === '3d' ? stored : DEFAULT_MAP_DIMENSION;
  } catch {
    return DEFAULT_MAP_DIMENSION;
  }
}

export function writeMapDimension(storage: Pick<Storage, 'setItem'> | null, value: MapDimension): void {
  try {
    storage?.setItem(MAP_DIMENSION_STORAGE_KEY, value);
  } catch {
    // 사생활 보호 모드 등에서 저장이 막혀도 화면은 그대로 동작한다.
  }
}
