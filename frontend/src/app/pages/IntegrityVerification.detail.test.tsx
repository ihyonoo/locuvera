import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import IntegrityVerification from './IntegrityVerification';

function storeAdminSession() {
  sessionStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: 'test-token',
      expires_at: 9999999999,
      user: { user_id: 1, username: 'admin', display_name: '관리자', role: 'admin' },
    }),
  );
}

const TAG_ID = 'a83f2c9e-6b1d-4e2a-9c77-51f8d20b6a44:1:0007';

const HISTORY_PAYLOAD = {
  ok: true,
  count: 1,
  items: [
    {
      usage_id: 42,
      user: { name: '박수현', position: '간호사', department: '응급의학과' },
      returned_by: { name: '김도윤', position: '전공의', department: '정형외과' },
      equipment: { tag_id: TAG_ID, name: '검체이송 카트 7호' },
      checkout: { reader_id: 'M101', location: '1층 병동 A', at: 1_700_000_000 },
      return: { reader_id: 'M503', location: '수술실', at: 1_700_003_600 },
      movement_path: [],
      blockchain: {
        verification_status: 'verified',
        verification_label: '검증 성공',
        db_record: null,
        tx_input_matches_db: true,
        transactions_root_matches: true,
        anchor: {
          block_number: 101,
          transaction_index: 0,
          transactions_root: '0xdeadbeefroot',
          recalculated_transactions_root: '0xdeadbeefroot',
        },
      },
    },
  ],
};

const LIVE_PAYLOAD = {
  ok: true,
  readers: [
    { reader_id: 'M101', location: '1층 병동 A', is_online: true, last_seen: 0, floor: 1 },
    { reader_id: 'M503', location: '수술실', is_online: true, last_seen: 0, floor: 5 },
  ],
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/verification']}>
      <Routes>
        <Route path="/verification" element={<IntegrityVerification />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openDetail() {
  const row = await screen.findByRole('button', { name: /검체이송 카트 7호/ });
  fireEvent.click(row);
  return screen.findByRole('dialog');
}

describe('IntegrityVerification usage detail popup', () => {
  beforeEach(() => {
    sessionStorage.clear();
    storeAdminSession();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => (String(url).includes('/rtls/live') ? LIVE_PAYLOAD : HISTORY_PAYLOAD),
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 조회 성공 경로가 통째로 try 안이라, 그 안에서 터진 예외가 조회 실패 메시지로 둔갑한다.
  it('reports no error when the history loads successfully', async () => {
    renderPage();

    await screen.findByRole('button', { name: /검체이송 카트 7호/ });
    expect(document.querySelector('.alert-error')).toBeNull();
  });

  it('keeps the list row to a summary and holds the chain details back for the popup', async () => {
    renderPage();

    await screen.findByRole('button', { name: /검체이송 카트 7호/ });
    // 머클 루트처럼 긴 값은 행을 밀어 올리므로 목록에 있으면 안 된다.
    expect(screen.queryByText(/0xdeadbeefroot/)).not.toBeInTheDocument();
    expect(screen.queryByText('머클 검증 결과')).not.toBeInTheDocument();
  });

  it('shows only the borrower with the location summary on the row', async () => {
    renderPage();

    const row = await screen.findByRole('button', { name: /검체이송 카트 7호/ });
    expect(within(row).getByText(/박수현/)).toBeInTheDocument();
    expect(within(row).queryByText(/김도윤/)).not.toBeInTheDocument();
    expect(within(row).getByText(/1층 병동 A/)).toBeInTheDocument();
    expect(within(row).getByText(/수술실/)).toBeInTheDocument();
  });

  it('keeps the year in the compact timestamps', async () => {
    renderPage();

    const row = await screen.findByRole('button', { name: /검체이송 카트 7호/ });
    expect(within(row).getByText(/2023-\d{2}-\d{2} \d{2}:\d{2} ~ 2023-\d{2}-\d{2} \d{2}:\d{2}/)).toBeInTheDocument();
  });

  it('opens a dialog with the full record when the row is clicked', async () => {
    renderPage();

    const dialog = within(await openDetail());
    expect(dialog.getByText('머클 검증 결과')).toBeInTheDocument();
    // 원본·재계산 두 줄에 모두 실린다.
    expect(dialog.getAllByText(/0xdeadbeefroot/)).toHaveLength(2);
    expect(dialog.getByText('의료 장비 사용 이력')).toBeInTheDocument();
  });

  it('carries the who/where/when summary into the dialog as well', async () => {
    renderPage();

    const dialog = within(await openDetail());
    expect(dialog.getByText('대여자')).toBeInTheDocument();
    expect(dialog.getByText('반납자')).toBeInTheDocument();
    // 팝업 안에서는 압축 포맷이 아니라 사람이 읽는 전체 시각을 보여준다 — 대여·반납 두 번.
    expect(dialog.getAllByText(/2023년.*시.*분.*초/)).toHaveLength(2);
  });

  it('shows an empty movement path message when there was no intermediate movement', async () => {
    renderPage();

    const dialog = within(await openDetail());
    expect(dialog.getByText('이동 기록 없음')).toBeInTheDocument();
  });

  it('renders the movement path timeline when the equipment moved between checkout and return', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            if (String(url).includes('/rtls/live')) return LIVE_PAYLOAD;
            return {
              ...HISTORY_PAYLOAD,
              items: [
                {
                  ...HISTORY_PAYLOAD.items[0],
                  movement_path: [
                    { location: '복도', at: 1_700_001_000 },
                    { location: '영상의학과', at: 1_700_002_000 },
                  ],
                },
              ],
            };
          },
        }),
      ),
    );

    renderPage();

    const dialog = within(await openDetail());
    // 경유 지점은 요약 줄에도 한 번 더 나오므로 타임라인으로 좁혀 확인한다.
    const timeline = within(dialog.getByRole('list', { name: '사용 기록 타임라인' }));
    expect(timeline.getByText('복도')).toBeInTheDocument();
    expect(timeline.getByText('영상의학과')).toBeInTheDocument();
    expect(dialog.queryByText('이동 기록 없음')).not.toBeInTheDocument();
  });

  it('closes the dialog again', async () => {
    renderPage();

    const dialog = await openDetail();
    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('no longer expands the row inline', async () => {
    renderPage();

    // 모달이 열리면 배경이 aria-hidden 처리되므로, 행 노드는 열기 전에 붙잡아 둔다.
    const row = await screen.findByRole('button', { name: /검체이송 카트 7호/ });
    fireEvent.click(row);
    await screen.findByRole('dialog');

    expect(within(row).queryByText('머클 검증 결과')).not.toBeInTheDocument();
  });
});
