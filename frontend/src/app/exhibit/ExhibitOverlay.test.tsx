import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
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
  {
    id: 'util',
    title: '장비 가동률 분석',
    role: 'admin',
    steps: [
      { do: 'go', to: '/admin/utilization' },
      { do: 'caption', text: '최근 7일 가동률 집계' },
      { do: 'wait', ms: 300 },
    ],
  },
];

// 진행도바가 한 단계 안에서 움직이는지 보려고 긴 대기 하나만 둔다
const SLOW_SCENES: Scene[] = [
  {
    id: 'slow',
    title: '느린 장면',
    role: 'admin',
    steps: [
      { do: 'caption', text: '천천히 차오름' },
      { do: 'wait', ms: 10_000 },
    ],
  },
];

// 간지는 테스트에서 짧게 띄운다
const CARD_MS = 20;

const fillWidth = () => parseFloat(screen.getAllByTestId('exhibit-progress-fill')[0].style.width);
const pass = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

// 2번 장면처럼 앱에 증명서 창이 열려 있는 상태
function CertificateOpen() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>검증 증명서</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}

// 실제 앱처럼 증명서와 전시 층을 한 트리에 둔다
async function renderOverCertificate() {
  render(
    <>
      <CertificateOpen />
      <ExhibitOverlay
        navigate={vi.fn()}
        scenes={SLOW_SCENES}
        ensureSession={async () => {}}
        isHumanEvent={fromPerson}
        idleMs={60_000}
        cardMs={CARD_MS}
      />
    </>,
  );
  await screen.findByRole('dialog');
  // Radix는 바깥 누름 감지를 다음 틱에 붙인다
  await pass(20);
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

  it('shows both a pause button and a take-over button during the tour', async () => {
    renderOverlay();

    expect(await screen.findByRole('button', { name: '일시정지' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '직접 조작하기' })).toBeInTheDocument();
  });

  it('flips the pause button to 계속 and back when toggled', async () => {
    renderOverlay();

    fireEvent.click(await screen.findByRole('button', { name: '일시정지' }));
    expect(screen.getByRole('button', { name: '계속' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '계속' }));
    expect(screen.getByRole('button', { name: '일시정지' })).toBeInTheDocument();
  });

  it('splits the progress bar into one section per scene and marks the one playing', async () => {
    renderOverlay();

    const sections = within(await screen.findByTestId('exhibit-progress')).getAllByRole('button');
    expect(sections.map((section) => section.textContent)).toEqual(['01 기기 상태', '02 장비 가동률 분석']);
    expect(sections[0]).toHaveAttribute('aria-current', 'step');
    expect(sections[1]).not.toHaveAttribute('aria-current');
  });

  it('jumps to the pressed section, starting from its title card', async () => {
    const { navigate } = renderOverlay();
    await screen.findByTestId('exhibit-caption');

    fireEvent.click(screen.getByRole('button', { name: '02 장비 가동률 분석' }));

    const card = screen.getByTestId('exhibit-card');
    expect(card).toHaveClass('exhibit-card--on');
    expect(card).toHaveTextContent('장비 가동률 분석');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/utilization'));
  });

  it('lifts the pause and keeps playing when a section is pressed while paused', async () => {
    renderOverlay();
    await screen.findByTestId('exhibit-caption');
    fireEvent.click(screen.getByRole('button', { name: '일시정지' }));

    fireEvent.click(screen.getByRole('button', { name: '02 장비 가동률 분석' }));

    expect(screen.getByRole('button', { name: '일시정지' })).toBeInTheDocument();
    // 2번 장면을 마치고 1번 간지로 넘어가면 멈춤 문을 지난 것이다
    await vi.waitFor(() => expect(screen.getByTestId('exhibit-card')).toHaveTextContent('01'));
  });

  it('closes an open dialog before replaying a scene, since the same page is not redrawn', async () => {
    renderOverlay();
    await screen.findByTestId('exhibit-caption');
    const escapes: string[] = [];
    const listen = (event: KeyboardEvent) => escapes.push(event.key);
    document.addEventListener('keydown', listen);

    fireEvent.click(screen.getByRole('button', { name: '01 기기 상태' }));
    document.removeEventListener('keydown', listen);

    expect(escapes).toContain('Escape');
  });

  it('fills the progress bar little by little while a step plays', async () => {
    renderOverlay(vi.fn(), SLOW_SCENES);
    await screen.findByTestId('exhibit-caption');

    const first = await vi.waitFor(() => {
      const width = fillWidth();
      expect(width).toBeGreaterThan(0);
      return width;
    });
    await vi.waitFor(() => expect(fillWidth()).toBeGreaterThan(first));
    expect(fillWidth()).toBeLessThan(100);
  });

  it('holds the progress bar still while paused', async () => {
    renderOverlay(vi.fn(), SLOW_SCENES);
    await screen.findByTestId('exhibit-caption');
    await vi.waitFor(() => expect(fillWidth()).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: '일시정지' }));
    const held = fillWidth();
    await pass(150);

    expect(fillWidth()).toBe(held);
  });

  it('keeps an open certificate on screen when the tour is paused', async () => {
    await renderOverCertificate();
    // 증명서가 열려 있으면 Radix가 바깥 요소를 화면 낭독기에서 숨긴다
    const pause = screen.getByRole('button', { name: '일시정지', hidden: true });

    fireEvent.pointerDown(pause);
    fireEvent.click(pause);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '계속', hidden: true })).toBeInTheDocument();
  });

  it('keeps an open certificate on screen when a visitor clicks the shield', async () => {
    await renderOverCertificate();

    fireEvent.pointerDown(screen.getByTestId('exhibit-shield'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
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
    expect(screen.getByTestId('exhibit-card')).toHaveTextContent('장비 가동률 분석');
  });

  it('goes straight back to the tour from the button without waiting a minute', async () => {
    renderOverlay();
    await screen.findByTestId('exhibit-caption');
    fireEvent.click(screen.getByRole('button', { name: '직접 조작하기' }));

    fireEvent.click(screen.getByRole('button', { name: '자동 시연으로 돌아가기' }));

    expect(screen.queryByText(/직접 조작 중/)).not.toBeInTheDocument();
    expect(screen.getByTestId('exhibit-card')).toHaveTextContent('장비 가동률 분석');
  });
});
