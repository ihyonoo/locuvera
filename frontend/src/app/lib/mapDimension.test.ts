import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAP_DIMENSION, isWebGLAvailable } from './mapDimension';

describe('DEFAULT_MAP_DIMENSION', () => {
  it('opens in 3d by default', () => {
    expect(DEFAULT_MAP_DIMENSION).toBe('3d');
  });
});

describe('isWebGLAvailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports false in jsdom without touching the canvas', () => {
    const createElement = vi.spyOn(document, 'createElement');
    expect(isWebGLAvailable()).toBe(false);
    expect(createElement).not.toHaveBeenCalledWith('canvas');
  });

  it('reports true when the browser can create a webgl context', () => {
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {});
    const canvas = document.createElement('canvas');
    const gl = { getExtension: () => null };
    vi.spyOn(canvas, 'getContext').mockImplementation(((kind: string) => (kind === 'webgl2' ? gl : null)) as never);
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    expect(isWebGLAvailable()).toBe(true);
  });

  it('releases the probe context right away so it does not count against the browser limit', () => {
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {});
    const loseContext = vi.fn();
    const gl = { getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null) };
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockImplementation(((kind: string) => (kind === 'webgl2' ? gl : null)) as never);
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    expect(isWebGLAvailable()).toBe(true);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('reports false when creating the context fails', () => {
    vi.stubGlobal('WebGLRenderingContext', function WebGLRenderingContext() {});
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockImplementation(() => {
      throw new Error('gpu blocked');
    });
    vi.spyOn(document, 'createElement').mockReturnValue(canvas);
    expect(isWebGLAvailable()).toBe(false);
  });
});
