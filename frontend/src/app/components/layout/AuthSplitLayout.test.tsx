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

  it('puts the logo above the form, not over the photo', () => {
    renderAt('/login');
    const link = screen.getByRole('link', { name: 'Locuvera' });
    expect(link.closest('.auth-split__form')).not.toBeNull();
    expect(link.closest('.auth-split__media')).toBeNull();
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
