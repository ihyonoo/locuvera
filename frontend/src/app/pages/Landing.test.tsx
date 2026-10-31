import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import Landing from './Landing';

describe('Landing', () => {
  it('renders the headline and points every login/signup link to the right route', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('위변조 없이');

    const loginLinks = screen.getAllByRole('link', { name: '로그인' });
    expect(loginLinks.length).toBeGreaterThan(0);
    loginLinks.forEach((link) => expect(link).toHaveAttribute('href', '/login'));

    const signupLinks = screen.getAllByRole('link', { name: '회원가입' });
    expect(signupLinks.length).toBeGreaterThan(0);
    signupLinks.forEach((link) => expect(link).toHaveAttribute('href', '/signup'));
  });

  it('renders both core feature sections', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    );

    expect(screen.getByText('블록체인 무결성 검증')).toBeInTheDocument();
    expect(screen.getByText('실시간 위치 추적 (BLE 기반 RTLS)')).toBeInTheDocument();
  });

  it('shows the shield-and-wordmark logo in the nav', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    );

    const brand = screen.getByRole('button', { name: 'Locuvera' });
    expect(within(brand).getByRole('img', { name: 'Locuvera' })).toBeInTheDocument();
  });
});
