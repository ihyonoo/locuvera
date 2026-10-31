import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import Login from './Login';

function renderLogin() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Login />
    </MemoryRouter>,
  );
}

function roleOption(label: string) {
  return screen.getByRole('radio', { name: label });
}

describe('Login role picker', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, token: 't', expires_at: 9999999999, user: { role: 'admin' } }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('puts the badge-type tabs above the title, not under the password', () => {
    renderLogin();
    const tabs = screen.getByRole('radiogroup', { name: '로그인 권한' });
    const heading = screen.getByRole('heading', { name: 'Login' });
    expect(tabs.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      tabs.compareDocumentPosition(screen.getByLabelText('비밀번호')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps the title as Login whichever badge is picked', () => {
    renderLogin();
    fireEvent.click(roleOption('관리자'));
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
  });

  it('offers both roles as visible choices instead of a dropdown', () => {
    renderLogin();
    expect(roleOption('의료진')).toBeInTheDocument();
    expect(roleOption('관리자')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('starts with 의료진 selected', () => {
    renderLogin();
    expect(roleOption('의료진')).toBeChecked();
    expect(roleOption('관리자')).not.toBeChecked();
  });

  it('sends the picked role with the login request', async () => {
    renderLogin();
    fireEvent.click(roleOption('관리자'));
    expect(roleOption('관리자')).toBeChecked();
    expect(roleOption('의료진')).not.toBeChecked();

    fireEvent.change(screen.getByLabelText('아이디'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => {
      const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
      expect(body.role).toBe('admin');
    });
  });
});

describe('Login demo buttons', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          token: 'demo-token',
          expires_at: 9999999999,
          user: { role: 'staff', is_demo: true },
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function firstCall() {
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    return { url: String(url), body: JSON.parse((init as RequestInit).body as string) };
  }

  it('requests a staff demo session without credentials', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: '의료진 데모' }));

    await waitFor(() => {
      const { url, body } = firstCall();
      expect(url).toContain('/auth/demo-login');
      expect(body.role).toBe('staff');
    });
  });

  it('requests an admin demo session', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: '관리자 데모' }));

    await waitFor(() => {
      expect(firstCall().body.role).toBe('admin');
    });
  });

  it('stores the issued demo session', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: '의료진 데모' }));

    await waitFor(() => {
      const stored = JSON.parse(sessionStorage.getItem('auth_session') ?? '{}');
      expect(stored.token).toBe('demo-token');
    });
  });

  it('shows an error when the demo session cannot be issued', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ detail: '데모 로그인이 비활성화되어 있습니다.' }),
    } as Response);
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: '의료진 데모' }));

    expect(await screen.findByText('데모 로그인이 비활성화되어 있습니다.')).toBeInTheDocument();
  });
});

describe('Login fields', () => {
  it('offers the demo buttons without an explanatory sentence', () => {
    renderLogin();
    expect(screen.getByRole('button', { name: '의료진 데모' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '관리자 데모' })).toBeInTheDocument();
    expect(screen.queryByText(/데모 계정으로 체험/)).not.toBeInTheDocument();
  });

  it('has only the title above the form, no subtitle', () => {
    renderLogin();
    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
    expect(document.querySelector('.auth-split__subtitle')).toBeNull();
  });

  it('shows Username/Password inside the boxes and keeps the labels only for screen readers', () => {
    renderLogin();
    for (const [name, placeholder] of [
      ['아이디', 'Username'],
      ['비밀번호', 'Password'],
    ]) {
      const input = screen.getByLabelText(name);
      expect(input).toHaveAttribute('placeholder', placeholder);
      expect(document.querySelector(`label[for="${input.id}"]`)).toHaveClass('sr-only');
    }
  });
});
