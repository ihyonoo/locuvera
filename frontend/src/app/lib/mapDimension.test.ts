import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAP_DIMENSION,
  MAP_DIMENSION_STORAGE_KEY,
  isWebGLAvailable,
  readMapDimension,
  writeMapDimension,
} from './mapDimension';

const storageWith = (value: string | null) => ({ getItem: () => value });

describe('readMapDimension', () => {
  it('opens in 3d by default', () => {
    expect(DEFAULT_MAP_DIMENSION).toBe('3d');
    expect(readMapDimension(storageWith(null), true)).toBe('3d');
  });

  it('follows the dimension the user picked last time', () => {
    expect(readMapDimension(storageWith('2d'), true)).toBe('2d');
    expect(readMapDimension(storageWith('3d'), true)).toBe('3d');
  });

  it('falls back to the default for an unknown stored value', () => {
    expect(readMapDimension(storageWith('flat'), true)).toBe(DEFAULT_MAP_DIMENSION);
  });

  it('falls back to the default when storage throws or is missing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readMapDimension(broken, true)).toBe(DEFAULT_MAP_DIMENSION);
    expect(readMapDimension(null, true)).toBe(DEFAULT_MAP_DIMENSION);
  });

  it('opens 2d without WebGL even if 3d was stored', () => {
    expect(readMapDimension(storageWith('3d'), false)).toBe('2d');
    expect(readMapDimension(storageWith(null), false)).toBe('2d');
  });
});

describe('writeMapDimension', () => {
  it('remembers the choice under its storage key', () => {
    const setItem = vi.fn();
    writeMapDimension({ setItem }, '2d');
    expect(setItem).toHaveBeenCalledWith(MAP_DIMENSION_STORAGE_KEY, '2d');
  });

  it('ignores storage that throws or is missing', () => {
    const broken = {
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => writeMapDimension(broken, '3d')).not.toThrow();
    expect(() => writeMapDimension(null, '3d')).not.toThrow();
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
