import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { subscribeThemeToRouter } from './lib/theme';
import { router } from './routes';

export default function App() {
  // 경로가 바뀔 때마다 테마를 맞춘다 — 랜딩·로그인 계열은 라이트, 앱 화면은 저장값
  useEffect(() => subscribeThemeToRouter(router), []);

  return <RouterProvider router={router} />;
}
