import { type ReactNode } from 'react';
import { Link } from 'react-router';
import BrandLogo from '../BrandLogo';
import { LOGIN_PATH } from '../../lib/auth';

type AuthSplitLayoutProps = {
  title: string;
  subtitle?: string;
  // 제목 위에 놓을 내용(로그인의 출입증 종류 탭)
  beforeTitle?: ReactNode;
  children: ReactNode;
};

// 인증 화면 공통 레이아웃: 상단바 없이 화면 가운데에 직원 출입증 모양 카드 하나를 둔다.
// 카드 위쪽 양 모서리의 구멍에서 목줄이 한 가닥씩 위로 올라간다. 목줄·구멍·NFC 칩은 장식이다.
// 로그인 화면으로 가는 로고는 머리줄 왼쪽에 둔다.
export default function AuthSplitLayout({ title, subtitle, beforeTitle, children }: AuthSplitLayoutProps) {
  return (
    <main className="auth-split">
      <div className="auth-split__card">
        <span className="auth-split__strap auth-split__strap--left" aria-hidden="true" />
        <span className="auth-split__strap auth-split__strap--right" aria-hidden="true" />
        <span className="auth-split__hole auth-split__hole--left" aria-hidden="true" />
        <span className="auth-split__hole auth-split__hole--right" aria-hidden="true" />
        <div className="auth-split__header">
          <Link to={LOGIN_PATH} className="auth-brand">
            <BrandLogo className="auth-brand__logo" />
          </Link>
          <span className="auth-split__chip" aria-hidden="true" />
        </div>
        {beforeTitle}
        <h1 className="auth-split__title">{title}</h1>
        {subtitle ? <p className="auth-split__subtitle">{subtitle}</p> : null}
        <div className="auth-split__body">{children}</div>
      </div>
    </main>
  );
}
