import { describe, it, expect } from 'vitest';
import { getHomePath, getRedirectTarget, type AuthUser } from './auth';

function user(role: string): AuthUser {
  return { user_id: 1, username: 'tester', display_name: '테스터', role };
}

describe('getHomePath', () => {
  it('sends signed-out visitors to the login page', () => {
    expect(getHomePath(null)).toBe('/login');
  });

  it('sends admins to the usage history page', () => {
    expect(getHomePath(user('admin'))).toBe('/verification');
  });

  it('sends staff to the equipment search page', () => {
    expect(getHomePath(user('staff'))).toBe('/equipment');
  });

  // 서버가 대문자로 내려주더라도 판정이 흔들리면 안 된다.
  it('matches the admin role case-insensitively', () => {
    expect(getHomePath(user('ADMIN'))).toBe('/verification');
  });

  it('falls back to equipment search for any other role', () => {
    expect(getHomePath(user('viewer'))).toBe('/equipment');
  });
});

describe('getRedirectTarget open-redirect guard', () => {
  it('keeps an in-app path', () => {
    expect(getRedirectTarget('?redirect=%2Fnfc%2Fpump-001%3Fuid%3D04AABB')).toBe('/nfc/pump-001?uid=04AABB');
  });

  it('rejects a protocol-relative URL that would leave the site', () => {
    // //evil.com 은 슬래시로 시작하지만 브라우저는 외부 주소로 해석한다.
    expect(getRedirectTarget('?redirect=%2F%2Fevil.example.com')).toBeNull();
  });

  it('rejects a backslash that some browsers treat like //', () => {
    expect(getRedirectTarget('?redirect=%2F%5Cevil.example.com')).toBeNull();
  });

  it('rejects an absolute URL', () => {
    expect(getRedirectTarget('?redirect=https%3A%2F%2Fevil.example.com')).toBeNull();
  });
});
