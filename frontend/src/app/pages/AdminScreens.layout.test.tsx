import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import IntegrityVerification from './IntegrityVerification';
import NfcMapping from './NfcMapping';
import DeviceStatus from './DeviceStatus';
import SignupRequests from './SignupRequests';
import EquipmentUtilization from './EquipmentUtilization';
import NfcEquipment from './NfcEquipment';

const ADMIN_PAGES = [
  { Page: IntegrityVerification, path: '/verification', label: '이력 조회' },
  { Page: EquipmentUtilization, path: '/admin/utilization', label: '가동률 분석' },
  { Page: NfcMapping, path: '/admin/nfc-mapping', label: 'NFC 매핑' },
  { Page: DeviceStatus, path: '/admin/devices', label: '기기 상태' },
  { Page: SignupRequests, path: '/admin/signup-requests', label: '가입 승인' },
];

function signIn(role = 'admin') {
  sessionStorage.setItem(
    'auth_session',
    JSON.stringify({
      token: 'test-token',
      expires_at: 9999999999,
      user: { user_id: 1, username: 'user', display_name: '사용자', role },
    }),
  );
}

function resize(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });
}

describe('관리자와 NFC 화면의 공용 메뉴', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    signIn();
    resize(1440);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, count: 0, items: [], readers: [] }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
    resize(1440);
  });

  it.each(ADMIN_PAGES)('$label 화면에서 현재 메뉴를 표시하고 테마를 전환한다', async ({ Page, path, label }) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Page />
      </MemoryRouter>,
    );
    const nav = await screen.findByRole('navigation', { name: '메뉴' });
    expect(within(nav).getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '다크 모드로 바꾸기' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('locuvera-theme')).toBe('dark');
    fireEvent.click(screen.getByRole('button', { name: '라이트 모드로 바꾸기' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it.each(['staff', 'admin'])(
    'NFC 태깅은 %s 권한의 메뉴를 표시하고 관련 없는 메뉴를 활성화하지 않는다',
    async (role) => {
      signIn(role);
      render(
        <MemoryRouter initialEntries={['/nfc/pump-001']}>
          <NfcEquipment />
        </MemoryRouter>,
      );
      const nav = await screen.findByRole('navigation', { name: '메뉴' });
      const home = role === 'admin' ? '이력 조회' : '장비 검색';
      expect(within(nav).getByRole('button', { name: home })).toBeInTheDocument();
      expect(within(nav).getByRole('button', { name: '마이페이지' })).toBeInTheDocument();
      for (const button of within(nav).getAllByRole('button')) expect(button).not.toHaveAttribute('aria-current');
      fireEvent.click(screen.getByRole('button', { name: '다크 모드로 바꾸기' }));
      expect(document.documentElement).toHaveClass('dark');
    },
  );

  it.each([
    { Page: IntegrityVerification, path: '/verification', placeholder: '이름, 사용자 ID' },
    { Page: NfcMapping, path: '/admin/nfc-mapping', placeholder: '예: 수액펌프' },
  ])('$path 검색 초안을 화면 폭이 달라져도 보존하고 휴대폰 메뉴를 연다', async ({ Page, path, placeholder }) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Page />
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByPlaceholderText(placeholder), { target: { value: '검색 초안' } });
    resize(375);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '상세검색' }));
    expect(screen.getByPlaceholderText(placeholder)).toHaveValue('검색 초안');
    fireEvent.click(screen.getByRole('button', { name: '메뉴 열기' }));
    expect(
      within(screen.getByRole('navigation', { name: '메뉴' })).getByRole('button', { name: '기기 상태' }),
    ).toBeInTheDocument();
    resize(1440);
    expect(screen.getByPlaceholderText(placeholder)).toHaveValue('검색 초안');
  });
});
