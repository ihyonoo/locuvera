import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import AdminNav from './AdminNav';

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

describe('AdminNav', () => {
  it('marks only the active tab with app-nav-tab--active', () => {
    render(
      <MemoryRouter initialEntries={['/admin/devices']}>
        <AdminNav active="devices" />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: '기기 상태' })).toHaveClass('app-nav-tab--active');
    expect(screen.getByRole('button', { name: 'NFC 매핑' })).toHaveClass('app-nav-tab');
    expect(screen.getByRole('button', { name: 'NFC 매핑' })).not.toHaveClass('app-nav-tab--active');
  });

  it('navigates to the matching route when an inactive tab is clicked', () => {
    render(
      <MemoryRouter initialEntries={['/admin/devices']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <AdminNav active="devices" />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'NFC 매핑' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/nfc-mapping');
  });

  it('has a signup approval tab between device status and my page', () => {
    render(
      <MemoryRouter initialEntries={['/admin/signup-requests']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <AdminNav active="signup-requests" />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels.indexOf('가입 승인')).toBe(labels.indexOf('기기 상태') + 1);
    expect(labels.indexOf('마이페이지')).toBe(labels.indexOf('가입 승인') + 1);
    expect(screen.getByRole('button', { name: '가입 승인' })).toHaveClass('app-nav-tab--active');

    fireEvent.click(screen.getByRole('button', { name: '기기 상태' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/admin/devices');
  });

  describe('on a narrow (mobile) viewport', () => {
    beforeEach(() => setViewportWidth(375));
    afterEach(() => setViewportWidth(1440));

    it('hides the tab buttons behind a menu toggle', () => {
      render(
        <MemoryRouter initialEntries={['/admin/devices']}>
          <AdminNav active="devices" />
        </MemoryRouter>,
      );

      expect(screen.queryByRole('button', { name: 'NFC 매핑' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '메뉴 열기' })).toBeInTheDocument();
    });

    it('reveals the tabs when the toggle is opened, and navigates + closes on tab click', () => {
      render(
        <MemoryRouter initialEntries={['/admin/devices']}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <AdminNav active="devices" />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>,
      );

      fireEvent.click(screen.getByRole('button', { name: '메뉴 열기' }));
      expect(screen.getByRole('button', { name: 'NFC 매핑' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'NFC 매핑' }));
      expect(screen.getByTestId('location')).toHaveTextContent('/admin/nfc-mapping');
      expect(screen.queryByRole('button', { name: 'NFC 매핑' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '메뉴 열기' })).toBeInTheDocument();
    });

    it('keeps the dropdown labels on one line instead of wrapping per character', () => {
      render(
        <MemoryRouter initialEntries={['/admin/devices']}>
          <AdminNav active="devices" />
        </MemoryRouter>,
      );

      fireEvent.click(screen.getByRole('button', { name: '메뉴 열기' }));

      expect(screen.getByRole('button', { name: 'NFC 매핑' })).toHaveClass('app-nav-tab--menu');
      expect(screen.getByRole('button', { name: '로그아웃' })).toHaveClass('app-nav-tab--menu');
    });
  });
});
