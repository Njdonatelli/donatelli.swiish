import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const SessionContext = createContext(null);

// One /api/setup/status and one /api/auth/me per load; views read the result from context instead of asking
// again. setup/status also says whether reset emails can be sent (mailConfigured).
export function SessionProvider({ api, children }) {
  const [state, setState] = useState({ status: 'loading', user: null, setup: null, error: null });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    let setup = null;
    try {
      setup = await api.get('/setup/status');
    } catch (e) {
      // Without setup/status the app still works: a user-less instance is caught by /auth/me failing, and
      // the forgot-password view treats unknown mail as not configured.
    }
    if (setup && setup.setupComplete === false) {
      if (mounted.current) setState({ status: 'setup', user: null, setup, error: null });
      return 'setup';
    }
    try {
      const user = await api.get('/auth/me');
      if (mounted.current) setState({ status: 'authenticated', user, setup, error: null });
      return 'authenticated';
    } catch (e) {
      const error = e.status === 401 ? null : e.message;
      if (mounted.current) setState({ status: 'anonymous', user: null, setup, error });
      return 'anonymous';
    }
  }, [api]);

  const logout = useCallback(async () => {
    try {
      await api.post('/logout');
    } catch (e) {
      // The cookie may already be gone; the local state still has to end.
    }
    setState((s) => ({ status: 'anonymous', user: null, setup: s.setup, error: null }));
  }, [api]);

  // Local end of a session the server already ended (sign out everywhere, expiry).
  const expire = useCallback(() => {
    setState((s) => (s.status === 'authenticated' ? { status: 'anonymous', user: null, setup: s.setup, error: null } : s));
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const off = api.onUnauthorized(expire);
    return () => {
      mounted.current = false;
      off();
    };
  }, [api, refresh, expire]);

  const value = useMemo(() => ({ ...state, refresh, logout, expire }), [state, refresh, logout, expire]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
