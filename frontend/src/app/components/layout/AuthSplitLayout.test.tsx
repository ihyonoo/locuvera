import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import AuthSplitLayout from './AuthSplitLayout';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>랜딩 화면</div>} />
        <Route
          path="/login"
          element={
            <AuthSplitLayout title="로그인" subtitle="부제">
              <form>폼</form>
            </AuthSplitLayout>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthSplitLayout', () => {
  it('has no app top bar above the auth pages', () => {
    const { container } = renderAt('/login');
    expect(container.querySelector('.app-shell__topbar')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
  });

  it('shows the logo in the corner as a link to the landing page', () => {
    renderAt('/login');
    const link = screen.getByRole('link', { name: 'Locuvera' });
    expect(link).toHaveAttribute('href', '/');
    expect(within(link).getByRole('img', { name: 'Locuvera' })).toBeInTheDocument();
  });

  it('puts the logo, title and form on one ID-badge card with no background photo', () => {
    const { container } = renderAt('/login');
    const card = container.querySelector('.auth-split__card');
    expect(card).not.toBeNull();
    for (const el of [
      screen.getByRole('link', { name: 'Locuvera' }),
      screen.getByRole('heading', { name: '로그인' }),
      screen.getByText('폼'),
    ]) {
      expect(card).toContainElement(el);
    }
    expect(container.querySelector('.auth-split__media')).toBeNull();
    expect(container.querySelector('img:not([role])')).toBeNull();
  });

  it('hangs from two straps through holes at the top-left and top-right corners, all hidden from assistive tech', () => {
    const { container } = renderAt('/login');
    for (const side of ['left', 'right']) {
      for (const part of ['strap', 'hole']) {
        expect(container.querySelector(`.auth-split__${part}--${side}`)).toHaveAttribute('aria-hidden', 'true');
      }
    }
    expect(container.querySelectorAll('.auth-split__strap')).toHaveLength(2);
    expect(container.querySelector('.auth-split__chip')).toHaveAttribute('aria-hidden', 'true');
  });

  it('goes to the landing page when the logo is clicked', () => {
    renderAt('/login');
    fireEvent.click(screen.getByRole('link', { name: 'Locuvera' }));
    expect(screen.getByText('랜딩 화면')).toBeInTheDocument();
  });

  it('still renders the title, subtitle and form', () => {
    renderAt('/login');
    expect(screen.getByRole('heading', { name: '로그인' })).toBeInTheDocument();
    expect(screen.getByText('부제')).toBeInTheDocument();
    expect(screen.getByText('폼')).toBeInTheDocument();
  });
});

describe('AuthSplitLayout extras', () => {
  it('puts the beforeTitle slot above the title', () => {
    render(
      <MemoryRouter>
        <AuthSplitLayout title="Login" beforeTitle={<div>출입증 종류</div>}>
          <form>폼</form>
        </AuthSplitLayout>
      </MemoryRouter>,
    );
    const slot = screen.getByText('출입증 종류');
    const heading = screen.getByRole('heading', { name: 'Login' });
    expect(slot.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
