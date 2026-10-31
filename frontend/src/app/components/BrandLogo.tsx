import { LOGO_ACCENT_PATH, LOGO_BASE_PATH, LOGO_VIEWBOX } from './brandLogoPaths';

// 방패 왼쪽과 "Locu"는 놓인 자리의 글자색(currentColor)을 따르고, 방패 오른쪽과 "vera"는 늘 청록이다.
// 크기는 CSS 높이로 정한다(너비는 viewBox 비율).
export default function BrandLogo({ className }: { className?: string }) {
  return (
    <svg viewBox={LOGO_VIEWBOX} role="img" aria-label="Locuvera" className={className}>
      <path fill="currentColor" d={LOGO_BASE_PATH} />
      <path fill="#0d9488" d={LOGO_ACCENT_PATH} />
    </svg>
  );
}
