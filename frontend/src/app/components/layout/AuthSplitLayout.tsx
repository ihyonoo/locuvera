import { type ReactNode } from 'react';
import { Link } from 'react-router';
import AuthImageCarousel from '../AuthImageCarousel';
import BrandLogo from '../BrandLogo';

type AuthSplitLayoutProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
};

// 인증 화면 공통 레이아웃: 상단바 없이 화면을 좌측 이미지 캐러셀 + 우측 폼으로 나눈다.
// 랜딩으로 돌아가는 로고는 사진이 아니라 폼 칸 왼쪽 위에 둔다(사진은 덮개 없이 원본 그대로).
export default function AuthSplitLayout({ title, subtitle, children }: AuthSplitLayoutProps) {
  return (
    <main className="auth-split">
      <div className="auth-split__media">
        <AuthImageCarousel />
      </div>

      <div className="auth-split__form">
        <Link to="/" className="auth-brand">
          <BrandLogo className="auth-brand__logo" />
        </Link>
        <div className="auth-split__form-inner fade-rise">
          <h1 className="auth-split__title">{title}</h1>
          {subtitle ? <p className="auth-split__subtitle">{subtitle}</p> : null}
          <div className="auth-split__body">{children}</div>
        </div>
      </div>
    </main>
  );
}
