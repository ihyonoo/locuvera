import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import StaffShell from './StaffShell';

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

function renderShell(ui: React.ReactElement, path = '/equipment') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              {ui}
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('StaffShell menu bar', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    setViewportWidth(1440);
    document.documentElement.classList.remove('dark');
  });

  it('lists the staff menu and marks the current page', () => {
    renderShell(
      <StaffShell menu="staff" current="equipment">
        본문
      </StaffShell>,
    );
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect(within(nav).getByRole('button', { name: '장비 검색' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: '마이페이지' })).not.toHaveAttribute('aria-current');
    expect(within(nav).queryByRole('button', { name: '가입 승인' })).not.toBeInTheDocument();
  });

  it('lists the admin menu for admins', () => {
    renderShell(
      <StaffShell menu="admin" current="mypage">
        본문
      </StaffShell>,
      '/me',
    );
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    for (const label of ['장비 사용 이력 조회', 'NFC 매핑', '기기 상태', '가입 승인', '마이페이지']) {
      expect(within(nav).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('button', { name: '마이페이지' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('button', { name: '장비 검색' })).not.toBeInTheDocument();
  });

  it('moves to the page of the clicked menu item', () => {
    renderShell(
      <StaffShell menu="staff" current="equipment">
        본문
      </StaffShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: '마이페이지' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/me');
  });

  it('logs out to the login page', () => {
    sessionStorage.setItem('auth_session', JSON.stringify({ token: 't', expires_at: 9999999999, user: {} }));
    renderShell(
      <StaffShell menu="staff" current="equipment">
        본문
      </StaffShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(sessionStorage.getItem('auth_session')).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('puts the logo in the sidebar when there is one', () => {
    renderShell(
      <StaffShell menu="staff" current="equipment" sidebar={<div>검색</div>} sidebarLabel="장비 검색 패널">
        본문
      </StaffShell>,
    );
    const sidebar = screen.getByRole('complementary', { name: '장비 검색 패널' });
    expect(within(sidebar).getByRole('img', { name: 'Locuvera' })).toBeInTheDocument();
    expect(within(screen.getByRole('banner')).queryByRole('img', { name: 'Locuvera' })).not.toBeInTheDocument();
  });

  it('puts the logo at the left of the menu bar when there is no sidebar', () => {
    renderShell(
      <StaffShell menu="staff" current="mypage">
        본문
      </StaffShell>,
      '/me',
    );
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(within(screen.getByRole('banner')).getByRole('img', { name: 'Locuvera' })).toBeInTheDocument();
  });

  it('switches this device to dark and back from the menu bar', () => {
    renderShell(
      <StaffShell menu="staff" current="equipment">
        본문
      </StaffShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: '다크 모드로 바꾸기' }));
    expect(localStorage.getItem('locuvera-theme')).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');

    fireEvent.click(screen.getByRole('button', { name: '라이트 모드로 바꾸기' }));
    expect(localStorage.getItem('locuvera-theme')).toBe('light');
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('folds the menu behind a button on phones', () => {
    setViewportWidth(375);
    renderShell(
      <StaffShell menu="staff" current="equipment">
        본문
      </StaffShell>,
    );
    expect(screen.queryByRole('button', { name: '마이페이지' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '메뉴 열기' }));
    fireEvent.click(screen.getByRole('button', { name: '마이페이지' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/me');
  });
});
