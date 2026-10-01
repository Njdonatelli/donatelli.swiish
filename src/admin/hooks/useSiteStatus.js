import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import usePoll from './usePoll';

const SiteStatusContext = createContext(null);

const MOVING = new Set(['publishing', 'preview_building']);
const FAST_MS = 5000;
const IDLE_MS = 60000;
// After a preview or publish request the run takes a few seconds to appear on GitHub; poll fast meanwhile
// so the bar moves on its own.
const FAST_AFTER_ACTION_MS = 90000;

function runMoving(run) {
  return !!run && (run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting' || run.status === 'pending');
}

export function isMoving(status) {
  if (!status) return false;
  return MOVING.has(status.state)
    || runMoving(status.production && status.production.run)
    || runMoving(status.preview && status.preview.run);
}

// One status poll for the whole shell: the pill, Overview, Card and Website all read the same object.
export function SiteStatusProvider({ api, children }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [failures, setFailures] = useState(0);
  const [pauseMs, setPauseMs] = useState(0);
  const [fastUntil, setFastUntil] = useState(0);

  const load = useCallback(async () => {
    try {
      const s = await api.get('/admin/site/status');
      setStatus(s);
      setError(null);
      setFailures(0);
      setPauseMs(0);
    } catch (e) {
      if (e.status === 503 && e.code === 'NOT_CONFIGURED') {
        setStatus({ configured: false, state: 'off', headline: e.message, detail: null, step: null, production: null, preview: null });
        setError(null);
        setFailures(0);
      } else {
        setError(e.message);
        setFailures((n) => n + 1);
        if (e.retryAfterSeconds) setPauseMs(e.retryAfterSeconds * 1000);
      }
    }
  }, [api]);

  // One transient failure keeps the fast poll, so the bar still follows a run after Publish; repeated
  // failures, or a GitHub rate limit with Retry-After, fall back so a failing endpoint is not hammered.
  const fast = failures < 2 && (isMoving(status) || Date.now() < fastUntil);
  const delay = Math.max(fast ? FAST_MS : IDLE_MS, pauseMs);
  usePoll(load, delay);

  const refresh = useCallback(async ({ fast: afterAction } = {}) => {
    if (afterAction) setFastUntil(Date.now() + FAST_AFTER_ACTION_MS);
    await load();
  }, [load]);

  const value = useMemo(() => ({ status, error, refresh }), [status, error, refresh]);
  return <SiteStatusContext.Provider value={value}>{children}</SiteStatusContext.Provider>;
}

export default function useSiteStatus() {
  return useContext(SiteStatusContext);
}
