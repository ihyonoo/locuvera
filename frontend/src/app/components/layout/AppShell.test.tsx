import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import AppShell from './AppShell';
import { storeAuthSession } from '../../lib/auth';

function signIn(role: string) {
  storeAuthSession({
    token: 'test-token',
    expires_at: 9999999999,
    user: { user_id: 1, username: 'tester', display_name: '테스터', role },
  });
}

function renderShell() {
  render(
    <MemoryRouter>
      <AppShell>본문</AppShell>
    </MemoryRouter>,
  );
  return screen.getByRole('link', { name: /Locuvera/ });
}

describe('AppShell brand logo', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('links back to the landing page while signed out', () => {
    expect(renderShell()).toHaveAttribute('href', '/');
  });

  it('links an admin to the usage history page', () => {
    signIn('admin');
    expect(renderShell()).toHaveAttribute('href', '/verification');
  });

  it('links staff to the equipment search page', () => {
    signIn('staff');
    expect(renderShell()).toHaveAttribute('href', '/equipment');
  });

  it('shows the shield-and-wordmark logo inside the home link', () => {
    const link = renderShell();
    expect(within(link).getByRole('img', { name: 'Locuvera' })).toHaveClass('brand-logo');
  });
});
