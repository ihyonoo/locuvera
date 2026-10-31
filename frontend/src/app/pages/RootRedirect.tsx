import { Navigate, useLocation } from 'react-router';
import { getHomePath, getStoredAuthUser } from '../lib/auth';

// 첫 화면은 로그인이다(로그인 상태면 권한별 첫 화면).
// 해시는 남긴다 — 백엔드가 Google 로그인 실패를 /#oauth_error=… 로 돌려보낸다.
export default function RootRedirect() {
  const { hash } = useLocation();
  return <Navigate to={{ pathname: getHomePath(getStoredAuthUser()), hash }} replace />;
}
