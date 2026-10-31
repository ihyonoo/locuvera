import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import SignUp from './SignUp';

function renderSignUp() {
  render(
    <MemoryRouter initialEntries={['/signup']}>
      <Routes>
        <Route path="/signup" element={<SignUp />} />
        <Route path="/login" element={<div>로그인 화면</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillForm(employeeNo = '20261031') {
  fireEvent.change(screen.getByLabelText('사번'), { target: { value: employeeNo } });
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: '홍길동' } });
  fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'hong@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
}

describe('SignUp request form', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, message: '접수' }) }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks only for employee number, name and email', () => {
    renderSignUp();
    expect(screen.getByLabelText('사번')).toBeInTheDocument();
    expect(screen.getByLabelText('이름')).toBeInTheDocument();
    expect(screen.getByLabelText('이메일')).toBeInTheDocument();
    expect(screen.queryByLabelText('비밀번호')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  // 로그인 카드와 같은 크기가 되도록 로그인처럼 칸 안 글자만 보이고 라벨은 화면 낭독기용으로 둔다.
  it('shows Employee ID/Name/Email inside the boxes and keeps the labels only for screen readers', () => {
    renderSignUp();
    for (const [name, placeholder] of [
      ['사번', 'Employee ID'],
      ['이름', 'Name'],
      ['이메일', 'Email'],
    ]) {
      const input = screen.getByLabelText(name);
      expect(input).toHaveAttribute('placeholder', placeholder);
      expect(document.querySelector(`label[for="${input.id}"]`)).toHaveClass('sr-only');
    }
  });

  it('explains in the subtitle only that an admin approves the request and sends a setup link', () => {
    renderSignUp();
    expect(document.querySelector('.auth-split__subtitle')).toHaveTextContent(
      /^관리자 승인 후 이메일로 비밀번호 설정 링크를 보내드립니다\.$/,
    );
  });

  it('sends the three fields to the signup request API and confirms receipt', async () => {
    renderSignUp();
    fillForm();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toMatch(/\/auth\/signup-requests$/);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      employee_no: '20261031',
      display_name: '홍길동',
      email: 'hong@example.com',
    });
    expect(await screen.findByText(/가입 요청이 접수되었습니다/)).toBeInTheDocument();
  });

  it('replaces the form with a one-line sent notice and waits for the user to go to login', async () => {
    renderSignUp();
    fillForm();

    expect(await screen.findByRole('heading', { name: 'Request sent' })).toBeInTheDocument();
    expect(screen.queryByLabelText('사번')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^가입 요청이 접수되었습니다\.$/);

    fireEvent.click(screen.getByRole('button', { name: 'Go to login' }));
    expect(screen.getByText('로그인 화면')).toBeInTheDocument();
  });

  it('rejects an employee number that is not eight digits before calling the server', async () => {
    renderSignUp();
    fillForm('1234');

    expect(await screen.findByText('사번은 숫자 8자리여야 합니다.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows why the server refused the request', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ detail: '이미 가입되었거나 요청 중인 사번입니다.' }),
    } as Response);
    renderSignUp();
    fillForm();

    expect(await screen.findByText('이미 가입되었거나 요청 중인 사번입니다.')).toBeInTheDocument();
  });
});

describe('SignUp Google switch', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('hides Google sign-up while Google login is off (default)', () => {
    renderSignUp();
    expect(screen.queryByRole('button', { name: 'Google로 가입하기' })).not.toBeInTheDocument();
    expect(screen.queryByText('또는')).not.toBeInTheDocument();
  });

  it('shows it when VITE_GOOGLE_LOGIN_ENABLED is true', () => {
    vi.stubEnv('VITE_GOOGLE_LOGIN_ENABLED', 'true');
    renderSignUp();
    expect(screen.getByRole('button', { name: 'Google로 가입하기' })).toBeInTheDocument();
  });
});
