import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { subscribeThemeToRouter } from './lib/theme';
import { router } from './routes';

export default function App() {
  // 경로가 바뀔 때마다 테마를 맞춘다 — 로그인 계열(과 거기로 넘어가는 '/')은 라이트, 앱 화면은 저장값
  useEffect(() => subscribeThemeToRouter(router), []);

  return <RouterProvider router={router} />;
}
