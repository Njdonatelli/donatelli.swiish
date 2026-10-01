import React, { useMemo } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { createApi } from './api';
import { SessionProvider, useSession } from './session';
import { SiteStatusProvider } from './hooks/useSiteStatus';
import { DraftProvider } from './hooks/useDraft';
import Shell from './Shell';
import LoginView from './views/LoginView';
import SetupView from './views/SetupView';
import ForgotPasswordView from './views/ForgotPasswordView';
import ResetPasswordView from './views/ResetPasswordView';
import VerifyEmailView from './views/VerifyEmailView';
import HomeView from './views/HomeView';
import CardView from './views/CardView';
import ConnectionsView from './views/ConnectionsView';
import ConnectionDetail from './views/ConnectionDetail';
import WebsiteView from './views/WebsiteView';
import AccountView from './views/AccountView';

function Loading() {
  return (
    <div className="loading" role="status">
      Loading the admin.
    </div>
  );
}

// Sends each session state to the one place it can be: no users → /setup, signed out → /login.
function RequireOwner({ api }) {
  const session = useSession();
  const location = useLocation();
  if (session.status === 'loading') return <Loading />;
  if (session.status === 'setup') return <Navigate to="/setup" replace />;
  if (session.status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return (
    <SiteStatusProvider api={api}>
      <DraftProvider api={api}>
        <Shell />
      </DraftProvider>
    </SiteStatusProvider>
  );
}

function PublicOnly({ children, allowSetupState = false }) {
  const session = useSession();
  if (session.status === 'loading') return <Loading />;
  if (session.status === 'setup' && !allowSetupState) return <Navigate to="/setup" replace />;
  if (session.status === 'authenticated') return <Navigate to="/admin" replace />;
  return children;
}

function SetupOnly({ children }) {
  const session = useSession();
  if (session.status === 'loading') return <Loading />;
  if (session.status === 'authenticated') return <Navigate to="/admin" replace />;
  if (session.status !== 'setup') return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes({ api }) {
  return (
    <Routes>
      <Route path="/setup" element={<SetupOnly><SetupView api={api} /></SetupOnly>} />
      <Route path="/login" element={<PublicOnly><LoginView api={api} /></PublicOnly>} />
      <Route path="/forgot-password" element={<PublicOnly><ForgotPasswordView api={api} /></PublicOnly>} />
      <Route path="/reset-password/:token" element={<PublicOnly><ResetPasswordView api={api} /></PublicOnly>} />
      {/* Verifying works signed in or out, so this route has no guard. */}
      <Route path="/verify-email/:token" element={<VerifyEmailView api={api} />} />
      <Route path="/admin" element={<RequireOwner api={api} />}>
        <Route index element={<HomeView api={api} />} />
        <Route path="card" element={<CardView api={api} />} />
        <Route path="connections" element={<ConnectionsView api={api} />} />
        <Route path="connections/:id" element={<ConnectionDetail api={api} />} />
        <Route path="website" element={<WebsiteView api={api} />} />
        <Route path="account" element={<AccountView api={api} />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}

export default function AdminApp() {
  const api = useMemo(() => createApi(), []);
  return (
    <BrowserRouter>
      <SessionProvider api={api}>
        <AppRoutes api={api} />
      </SessionProvider>
    </BrowserRouter>
  );
}
