import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import FloorMap3D from './FloorMap3D';
import { ZONE_BOUNDS } from '../../lib/floorZoneBounds';

// three.js는 jsdom에서 돌지 않으므로 실행체는 호출만 기록하는 가짜로, 층 모형 생성은 빈 값으로 바꾼다
const engine = vi.hoisted(() => ({ setFloor: vi.fn(), setEquipment: vi.fn() }));
vi.mock('./mapEngine', () => ({
  MapEngine: class {
    setFloor = engine.setFloor;
    setEquipment = engine.setEquipment;
    setFocus = vi.fn();
    setHighlight = vi.fn();
    setLabelsVisible = vi.fn();
    resize = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('./buildFloor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./buildFloor')>()),
  buildFloorModel: vi.fn(() => ({})),
}));

const pins = () => [
  { reader_id: 'M201', label: '채혈실' },
  { reader_id: 'M202', label: '호흡기검사실' },
];
const equipment = () => [{ tag_id: 't1', reader_id: 'M201', label: '수액펌프-001', assetStatus: 'available' }];
const props = (over: Partial<Parameters<typeof FloorMap3D>[0]> = {}) => ({
  floor: 2 as const,
  pins: pins(),
  equipment: equipment(),
  zoneBounds: ZONE_BOUNDS,
  onUnavailable: () => {},
  ...over,
});

describe('FloorMap3D', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    engine.setFloor.mockClear();
    engine.setEquipment.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not rebuild the floor or the equipment when the 1-second poll brings the same data in new arrays', () => {
    const view = render(<FloorMap3D {...props()} />);
    view.rerender(<FloorMap3D {...props()} />);
    view.rerender(<FloorMap3D {...props()} />);
    expect(engine.setFloor).toHaveBeenCalledTimes(1);
    expect(engine.setEquipment).toHaveBeenCalledTimes(1);
  });

  it('fits the view to a newly chosen floor', () => {
    const view = render(<FloorMap3D {...props()} />);
    view.rerender(<FloorMap3D {...props({ floor: 3, pins: [{ reader_id: 'M301', label: '심장혈관센터' }] })} />);
    expect(engine.setFloor).toHaveBeenCalledTimes(2);
    expect(engine.setFloor.mock.calls.map((c) => c[1])).toEqual([true, true]);
  });

  it('keeps the current view when only the dimmed zones change', () => {
    const view = render(<FloorMap3D {...props()} />);
    view.rerender(<FloorMap3D {...props({ spotlightReaderIds: ['M201'] })} />);
    expect(engine.setFloor).toHaveBeenCalledTimes(2);
    expect(engine.setFloor.mock.calls[1][1]).toBe(false);
  });

  it('offers the label toggle but no reset-view button', () => {
    render(<FloorMap3D {...props()} />);
    expect(screen.getByRole('checkbox', { name: '이름표' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '시점 초기화' })).not.toBeInTheDocument();
  });
});
