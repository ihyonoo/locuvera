import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Menu, Moon, Sun, X } from 'lucide-react';
import BrandLogo from '../BrandLogo';
import { getHomePath, getStoredAuthUser } from '../../lib/auth';
import { getStoredTheme, storeTheme, syncThemeForPath, type Theme } from '../../lib/theme';
import { useLogout } from '../../lib/useAuthGuard';
import { useMediaQuery } from '../../lib/useMediaQuery';

export type StaffMenu = 'staff' | 'admin';

export type StaffPageKey = 'equipment' | 'mypage' | 'verification' | 'nfc-mapping' | 'devices' | 'signup-requests';

const MENUS: Record<StaffMenu, { key: StaffPageKey; label: string; path: string }[]> = {
  staff: [
    { key: 'equipment', label: '장비 검색', path: '/equipment' },
    { key: 'mypage', label: '마이페이지', path: '/me' },
  ],
  admin: [
    { key: 'verification', label: '이력 조회', path: '/verification' },
    { key: 'nfc-mapping', label: 'NFC 매핑', path: '/admin/nfc-mapping' },
    { key: 'devices', label: '기기 상태', path: '/admin/devices' },
    { key: 'signup-requests', label: '가입 승인', path: '/admin/signup-requests' },
    { key: 'mypage', label: '마이페이지', path: '/me' },
  ],
};

// 항목이 많은 관리자 메뉴는 태블릿에서도 접는다
const WIDE_MENU_QUERY = '(min-width: 640px)';
const WIDE_ADMIN_MENU_QUERY = '(min-width: 1024px)';

type StaffShellProps = {
  menu: StaffMenu;
  current?: StaffPageKey;
  /** 왼쪽에 붙는 사이드바 내용. 없으면 메뉴바 왼쪽 끝에 로고를 둔다. */
  sidebar?: ReactNode;
  sidebarLabel?: string;
  children: ReactNode;
};

// 로고 — 로그인 상태면 권한별 첫 화면으로
function HomeLogo() {
  return (
    <Link to={getHomePath(getStoredAuthUser())} className="brand-lockup">
      <BrandLogo className="brand-logo" />
    </Link>
  );
}

// 화면 테마 — 라이트면 달(다크로), 다크면 해(라이트로). 이 기기에만 저장한다
function ThemeToggle() {
  const location = useLocation();
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? '다크 모드로 바꾸기' : '라이트 모드로 바꾸기';
  return (
    <button
      type="button"
      className="staff-icon-btn"
      aria-label={label}
      title={label}
      onClick={() => {
        setTheme(next);
        storeTheme(next);
        syncThemeForPath(location.pathname);
      }}
    >
      {next === 'dark' ? <Moon className="h-[1.1rem] w-[1.1rem]" /> : <Sun className="h-[1.1rem] w-[1.1rem]" />}
    </button>
  );
}

// 의료진·관리자 화면 공용 틀
// 메뉴바는 띠 없이 바탕 위 글자만, 오른쪽 끝에 테마 · 메뉴 · 로그아웃
// 사이드바는 폭 고정(접기·끌어서 조절 없음)이고 맨 위에 로고를 둔다
export default function StaffShell({ menu, current, sidebar, sidebarLabel, children }: StaffShellProps) {
  const navigate = useNavigate();
  const logout = useLogout();
  const wideMenu = useMediaQuery(menu === 'admin' ? WIDE_ADMIN_MENU_QUERY : WIDE_MENU_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);

  const menuItems = MENUS[menu].map((item) => (
    <button
      key={item.key}
      type="button"
      aria-current={item.key === current ? 'page' : undefined}
      className={item.key === current ? 'staff-menu__item staff-menu__item--on' : 'staff-menu__item'}
      onClick={() => {
        setMenuOpen(false);
        navigate(item.path);
      }}
    >
      {item.label}
    </button>
  ));

  const logoutButton = (
    <button type="button" className="staff-menu__item" onClick={logout}>
      로그아웃
    </button>
  );

  const header = (
    <header className={sidebar ? 'staff-top' : 'staff-top staff-top--logo'}>
      {sidebar ? null : (
        <div className="staff-top__brand">
          <HomeLogo />
        </div>
      )}
      <ThemeToggle />
      {wideMenu ? (
        <>
          <nav className="staff-menu" aria-label="메뉴">
            {menuItems}
          </nav>
          <span className="staff-menu__rule" aria-hidden="true" />
          {logoutButton}
        </>
      ) : (
        <div className="relative">
          <button
            type="button"
            className="staff-icon-btn"
            aria-label={menuOpen ? '메뉴 닫기' : '메뉴 열기'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          {menuOpen ? (
            <div className="staff-menu-pop">
              <nav className="flex flex-col" aria-label="메뉴">
                {menuItems}
              </nav>
              {logoutButton}
            </div>
          ) : null}
        </div>
      )}
    </header>
  );

  if (!sidebar) {
    return (
      <div className="staff">
        {header}
        <main>{children}</main>
      </div>
    );
  }

  return (
    <div className="staff staff-shell">
      <aside className="staff-sidebar" aria-label={sidebarLabel}>
        <div className="staff-sidebar__brand">
          <HomeLogo />
        </div>
        {sidebar}
      </aside>
      <div className="staff-shell__body">
        {header}
        <main>{children}</main>
      </div>
    </div>
  );
}
