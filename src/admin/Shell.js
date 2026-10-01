import React, { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, Link } from 'react-router-dom';
import Wordmark from './ui/Wordmark';
import Icon, { Globe, IdCard, LayoutDashboard, LogOut, User, Users } from './ui/Icon';
import StatusPill from './StatusPill';
import Callout from './ui/Callout';
import useSiteStatus from './hooks/useSiteStatus';
import { useDraftFlush } from './hooks/useDraft';
import { useSession } from './session';

const TABS = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/card', label: 'Card', icon: IdCard },
  { to: '/admin/connections', label: 'Connections', icon: Users },
  { to: '/admin/website', label: 'Website', icon: Globe },
];

function AccountMenu({ email, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="btn btn-quiet btn-icon"
        aria-label="Account menu"
        aria-haspopup="true"
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen(!open)}
      >
        <Icon as={User} size={20} />
      </button>
      {open ? (
        <div className="menu-pop">
          {email ? <p className="who">{email}</p> : null}
          <Link className="menu-item" to="/admin/account" onClick={() => setOpen(false)}>
            <Icon as={User} size={16} /> Account
          </Link>
          <button type="button" className="menu-item" onClick={onLogout}>
            <Icon as={LogOut} size={16} /> Log out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function Shell() {
  const session = useSession();
  const { status, error: statusError } = useSiteStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const first = useRef(true);

  // A route change inside the SPA moves focus to the new view's h1, so screen readers announce the page.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const h1 = document.querySelector('.main h1');
    if (h1) h1.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.pathname]);

  const flushDraft = useDraftFlush();
  const logout = async () => {
    // The session cookie goes with logout, so an edit still waiting to autosave is sent first.
    if (flushDraft) await flushDraft();
    await session.logout();
    navigate('/login', { replace: true });
  };

  const barred = session.user && session.user.role !== 'owner';

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <Wordmark to="/admin" />
        <div className="topbar-end">
          <StatusPill status={status} error={statusError} onOpen={() => navigate('/admin/website')} />
          <AccountMenu email={session.user && session.user.email} onLogout={logout} />
        </div>
      </header>
      <nav className="nav" aria-label="Admin">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end}>
            <Icon as={t.icon} size={20} />
            {t.label}
          </NavLink>
        ))}
      </nav>
      <main id="main" className="main">
        <div className="page">
          {barred ? (
            <Callout tone="warn" role="alert">
              <p>This account is not the owner, and every admin tool is owner-only. Log out and log in with the owner account.</p>
            </Callout>
          ) : (
            <Outlet />
          )}
        </div>
      </main>
    </div>
  );
}
