import { createBrowserRouter } from 'react-router';
import Landing from './pages/Landing';
import Login from './pages/Login';
import SignUp from './pages/SignUp';
import SignUpComplete from './pages/SignUpComplete';
import FindId from './pages/FindId';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';
import AuthCallback from './pages/AuthCallback';
import MyPage from './pages/MyPage';
import EquipmentSearch from './pages/EquipmentSearch';
import IntegrityVerification from './pages/IntegrityVerification';
import NfcMapping from './pages/NfcMapping';
import NfcEquipment from './pages/NfcEquipment';
import DeviceStatus from './pages/DeviceStatus';

export const router = createBrowserRouter([
  {
    path: '/',
    Component: Landing,
  },
  {
    path: '/login',
    Component: Login,
  },
  {
    path: '/signup',
    Component: SignUp,
  },
  {
    path: '/signup/complete',
    Component: SignUpComplete,
  },
  {
    path: '/find-id',
    Component: FindId,
  },
  {
    path: '/forgot-password',
    Component: ForgotPassword,
  },
  {
    path: '/reset-password',
    Component: ResetPassword,
  },
  {
    path: '/verify-email',
    Component: VerifyEmail,
  },
  {
    path: '/auth/callback',
    Component: AuthCallback,
  },
  {
    path: '/me',
    Component: MyPage,
  },
  {
    path: '/equipment',
    Component: EquipmentSearch,
  },
  {
    path: '/verification',
    Component: IntegrityVerification,
  },
  {
    path: '/admin/devices',
    Component: DeviceStatus,
  },
  {
    path: '/admin/nfc-mapping',
    Component: NfcMapping,
  },
  {
    path: '/nfc/:token',
    Component: NfcEquipment,
  },
]);
