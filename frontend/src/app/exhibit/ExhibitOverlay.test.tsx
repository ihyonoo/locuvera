import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExhibitOverlay from './ExhibitOverlay';
import type { Scene } from './player';

const fromPerson = () => true;

const SCENES: Scene[] = [
  {
    id: 'devices',
    title: '기기 상태',
    role: 'admin',
    steps: [
      { do: 'go', to: '/admin/devices' },
      { do: 'wait', ms: 300 },
    ],
  },
  { id: 'clip', title: '측위 보고 위조 차단', steps: [{ do: 'clip', src: '/exhibit/forge-ingest.mp4' }] },
];

function renderOverlay(navigate = vi.fn()) {
  const ensureSession = vi.fn(async () => {});
  render(
    <ExhibitOverlay
      navigate={navigate}
      scenes={SCENES}
      ensureSession={ensureSession}
      isHumanEvent={fromPerson}
      idleMs={60_000}
    />,
  );
  return { navigate, ensureSession };
}

describe('ExhibitOverlay', () => {
  afterEach(() => vi.useRealTimers());

  it('logs in with the scene role and plays the first scene', async () => {
    const { navigate, ensureSession } = renderOverlay();

    expect(await screen.findByText(/자동 시연 중/)).toBeInTheDocument();
    expect(screen.getByText('기기 상태')).toBeInTheDocument();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/devices'));
    expect(ensureSession).toHaveBeenCalledWith('admin');
  });

  it('plays a security clip and moves on when it ends', async () => {
    const navigate = vi.fn();
    renderOverlay(navigate);

    const video = await screen.findByTestId('exhibit-clip');
    expect(video).toHaveAttribute('src', '/exhibit/forge-ingest.mp4');

    fireEvent.ended(video);

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('exhibit-clip')).not.toBeInTheDocument();
  });

  it('hides the cursor while a clip plays', async () => {
    document.body.insertAdjacentHTML('beforeend', '<button id="target">대상</button>');
    render(
      <ExhibitOverlay
        navigate={vi.fn()}
        scenes={[
          { id: 'point', title: '가리키기', steps: [{ do: 'point', target: { selector: '#target' } }] },
          { id: 'clip', title: '클립', steps: [{ do: 'clip', src: '/exhibit/forge-ingest.mp4' }] },
        ]}
        ensureSession={vi.fn(async () => {})}
        isHumanEvent={fromPerson}
      />,
    );

    expect(await screen.findByTestId('exhibit-cursor')).toBeInTheDocument();
    await screen.findByTestId('exhibit-clip');

    expect(screen.queryByTestId('exhibit-cursor')).not.toBeInTheDocument();
    document.getElementById('target')?.remove();
  });

  it('hands the screen over when a person moves in, and takes it back after a quiet minute', async () => {
    renderOverlay();
    await screen.findByText(/자동 시연 중/);
    vi.useFakeTimers();

    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(screen.getByText(/직접 조작 중/)).toBeInTheDocument();
    expect(screen.getByText(/60초 동안 입력이 없으면/)).toBeInTheDocument();
    expect(screen.queryByTestId('exhibit-cursor')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText(/자동 시연 중/)).toBeInTheDocument();
  });
});
