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
      { do: 'caption', text: '리더 연결·태그 수신 상태 실시간 감시' },
      { do: 'wait', ms: 300 },
    ],
  },
  { id: 'clip', title: '측위 보고 위조 차단', steps: [{ do: 'clip', src: '/exhibit/forge-ingest.mp4' }] },
];

// 간지는 테스트에서 짧게 띄운다
const CARD_MS = 20;

function renderOverlay(navigate = vi.fn(), scenes = SCENES) {
  const ensureSession = vi.fn(async () => {});
  render(
    <ExhibitOverlay
      navigate={navigate}
      scenes={scenes}
      ensureSession={ensureSession}
      isHumanEvent={fromPerson}
      idleMs={60_000}
      cardMs={CARD_MS}
    />,
  );
  return { navigate, ensureSession };
}

describe('ExhibitOverlay', () => {
  afterEach(() => vi.useRealTimers());

  it('opens the scene with a numbered title card, logs in with its role and plays it', async () => {
    const { navigate, ensureSession } = renderOverlay();

    const card = await screen.findByTestId('exhibit-card');
    expect(card).toHaveTextContent('01');
    expect(card).toHaveTextContent('기기 상태');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/devices'));
    expect(ensureSession).toHaveBeenCalledWith('admin');
  });

  it('explains each step in a caption at the bottom and nothing else', async () => {
    renderOverlay();

    expect(await screen.findByTestId('exhibit-caption')).toHaveTextContent('리더 연결·태그 수신 상태 실시간 감시');
    expect(screen.queryByText(/마우스를 움직이면/)).not.toBeInTheDocument();
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
    renderOverlay(vi.fn(), [
      { id: 'point', title: '가리키기', steps: [{ do: 'point', target: { selector: '#target' } }] },
      { id: 'clip', title: '클립', steps: [{ do: 'clip', src: '/exhibit/forge-ingest.mp4' }] },
    ]);

    expect(await screen.findByTestId('exhibit-cursor')).toBeInTheDocument();
    await screen.findByTestId('exhibit-clip');

    expect(screen.queryByTestId('exhibit-cursor')).not.toBeInTheDocument();
    document.getElementById('target')?.remove();
  });

  it('keeps playing when a person moves the mouse or clicks, and blocks the app underneath', async () => {
    renderOverlay();
    await screen.findByTestId('exhibit-caption');

    act(() => {
      window.dispatchEvent(new Event('pointermove'));
      window.dispatchEvent(new Event('pointerdown'));
    });

    expect(screen.queryByText(/직접 조작 중/)).not.toBeInTheDocument();
    expect(screen.getByTestId('exhibit-caption')).toBeInTheDocument();
    expect(screen.getByTestId('exhibit-shield')).toBeInTheDocument();
  });

  it('hides the real mouse pointer until it moves, then hides it again', async () => {
    renderOverlay();
    const shield = await screen.findByTestId('exhibit-shield');
    vi.useFakeTimers();
    expect(shield).toHaveClass('exhibit-shield--still');

    fireEvent.pointerMove(shield);
    expect(shield).not.toHaveClass('exhibit-shield--still');

    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(shield).toHaveClass('exhibit-shield--still');
  });

  it('hands the screen over from the button, and takes it back after a quiet minute', async () => {
    renderOverlay();
    await screen.findByTestId('exhibit-caption');
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole('button', { name: '직접 조작하기' }));

    expect(screen.getByText(/직접 조작 중/)).toBeInTheDocument();
    expect(screen.getByText(/60초 동안 입력이 없으면/)).toBeInTheDocument();
    expect(screen.queryByTestId('exhibit-cursor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exhibit-caption')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exhibit-shield')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByText(/직접 조작 중/)).not.toBeInTheDocument();
    expect(screen.getByTestId('exhibit-card')).toHaveTextContent('측위 보고 위조 차단');
  });

  it('goes straight back to the tour from the button without waiting a minute', async () => {
    renderOverlay();
    await screen.findByTestId('exhibit-caption');
    fireEvent.click(screen.getByRole('button', { name: '직접 조작하기' }));

    fireEvent.click(screen.getByRole('button', { name: '자동 시연으로 돌아가기' }));

    expect(screen.queryByText(/직접 조작 중/)).not.toBeInTheDocument();
    expect(screen.getByTestId('exhibit-card')).toHaveTextContent('측위 보고 위조 차단');
  });
});
