import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import EquipmentSearch from './EquipmentSearch';

const livePayload = {
  ok: true,
  count: 0,
  ts: 0,
  items: [],
  readers: [],
  readers_online: 0,
  readers_total: 0,
  tags_online: 0,
  tags_total: 0,
};

function liveRequestCount() {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes('/rtls/live')).length;
}

// 응답 처리와 다음 타이머 예약까지 마이크로태스크를 비운다
const flush = () => act(async () => {});

describe('EquipmentSearch live location polling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    sessionStorage.clear();
    sessionStorage.setItem(
      'auth_session',
      JSON.stringify({
        token: 'test-token',
        expires_at: 9999999999,
        user: { user_id: 1, username: 'u', display_name: 'u', role: 'staff' },
      }),
    );
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve({ ok: true, status: 200, json: async () => livePayload })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks for live locations again half a second after each response', async () => {
    render(
      <MemoryRouter initialEntries={['/equipment']}>
        <Routes>
          <Route path="/equipment" element={<EquipmentSearch />} />
        </Routes>
      </MemoryRouter>,
    );
    await flush();
    expect(liveRequestCount()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(liveRequestCount()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(liveRequestCount()).toBe(2);
  });
});
