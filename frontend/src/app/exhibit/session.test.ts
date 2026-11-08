import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthUser, getStoredAuthSession, storeAuthSession } from '../lib/auth';
import { API_BASE_URL } from '../lib/runtime';
import { ensureDemoSession } from './session';

const nowSec = () => Math.floor(Date.now() / 1000);

function demoUser(role: 'admin' | 'staff', isDemo = true): AuthUser {
  return { user_id: 7, username: `demo-${role}`, display_name: '데모', role, is_demo: isDemo };
}

function demoLoginResponse(role: 'admin' | 'staff') {
  return new Response(
    JSON.stringify({ ok: true, token: `new-${role}-token`, expires_at: nowSec() + 43_200, user: demoUser(role) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('ensureDemoSession', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it('keeps a fresh demo session of the needed role', async () => {
    storeAuthSession({ token: 'kept', expires_at: nowSec() + 3600, user: demoUser('admin') });
    const fetchMock = vi.fn();

    await ensureDemoSession('admin', fetchMock);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getStoredAuthSession()?.token).toBe('kept');
  });

  it('logs in as the demo account when there is no session', async () => {
    const fetchMock = vi.fn(async () => demoLoginResponse('admin'));

    await ensureDemoSession('admin', fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/auth/demo-login`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ role: 'admin' }) }),
    );
    expect(getStoredAuthSession()?.token).toBe('new-admin-token');
  });

  it('switches the demo role when the next screen needs the other one', async () => {
    storeAuthSession({ token: 'staff', expires_at: nowSec() + 3600, user: demoUser('staff') });
    const fetchMock = vi.fn(async () => demoLoginResponse('admin'));

    await ensureDemoSession('admin', fetchMock);

    expect(getStoredAuthSession()?.user.role).toBe('admin');
  });

  it('replaces a real account so the unattended screen never keeps real privileges', async () => {
    storeAuthSession({ token: 'real', expires_at: nowSec() + 3600, user: demoUser('admin', false) });
    const fetchMock = vi.fn(async () => demoLoginResponse('admin'));

    await ensureDemoSession('admin', fetchMock);

    expect(getStoredAuthSession()?.token).toBe('new-admin-token');
  });

  it('renews a session that is about to expire', async () => {
    storeAuthSession({ token: 'old', expires_at: nowSec() + 60, user: demoUser('staff') });
    const fetchMock = vi.fn(async () => demoLoginResponse('staff'));

    await ensureDemoSession('staff', fetchMock);

    expect(getStoredAuthSession()?.token).toBe('new-staff-token');
  });

  it('fails when the server refuses the demo login', async () => {
    const fetchMock = vi.fn(async () => new Response('{"detail":"Not Found"}', { status: 404 }));

    await expect(ensureDemoSession('admin', fetchMock)).rejects.toThrow();
  });
});
