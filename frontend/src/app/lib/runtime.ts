function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? `${window.location.protocol}//${window.location.hostname}:8000`;

export const PUBLIC_APP_URL = trimTrailingSlash(import.meta.env.VITE_PUBLIC_APP_URL ?? window.location.origin);

// Google 로그인은 기본 꺼짐 — 'true'일 때만 로그인·가입·마이페이지에 Google 버튼을 보인다.
// 백엔드 GOOGLE_LOGIN_ENABLED와 같은 값으로 맞춘다. 테스트가 바꿀 수 있게 부를 때마다 읽는다.
export function isGoogleLoginEnabled() {
  return import.meta.env.VITE_GOOGLE_LOGIN_ENABLED === 'true';
}
