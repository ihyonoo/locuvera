import { Suspense, lazy, useEffect, useState } from 'react';
import { RouterProvider } from 'react-router';
import { syncExhibitFlag } from './exhibit/mode';
import { subscribeThemeToRouter } from './lib/theme';
import { router } from './routes';

// 학술제 전시 모드(?exhibit=1). 일반 방문에서는 모듈을 받지 않는다
const ExhibitOverlay = lazy(() => import('./exhibit/ExhibitOverlay'));

export default function App() {
  // 경로가 바뀔 때마다 테마를 맞춘다 — 로그인 계열(과 거기로 넘어가는 '/')은 라이트, 앱 화면은 저장값
  useEffect(() => subscribeThemeToRouter(router), []);
  const [exhibit] = useState(() => syncExhibitFlag(window.location.search));

  return (
    <>
      <RouterProvider router={router} />
      {exhibit ? (
        <Suspense fallback={null}>
          <ExhibitOverlay navigate={(to) => router.navigate(to)} />
        </Suspense>
      ) : null}
    </>
  );
}
