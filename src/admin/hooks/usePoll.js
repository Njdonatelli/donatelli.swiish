import { useEffect, useRef } from 'react';

// Runs fn now and then every delayMs, but never while the tab is hidden: a background tab would otherwise
// spend the owner's rate-limit budget and GitHub's for nothing. A changed delay keeps the last run's
// timing instead of firing again straight away.
export default function usePoll(fn, delayMs, enabled = true) {
  const fnRef = useRef(fn);
  const lastRun = useRef(0);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    let stopped = false;
    // Local to this effect: a request from an earlier delay must not block this effect's own restart.
    let inFlight = false;

    const run = async () => {
      timer = null;
      if (stopped || document.hidden) return;
      lastRun.current = Date.now();
      inFlight = true;
      try {
        await fnRef.current();
      } finally {
        inFlight = false;
        if (!stopped && !document.hidden) timer = setTimeout(run, delayMs);
      }
    };
    // A hide and show while a request is out must not start a second chain: that request's finally
    // schedules the next run.
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = null;
      } else if (!timer && !inFlight) {
        run();
      }
    };

    const wait = Math.max(0, lastRun.current + delayMs - Date.now());
    timer = setTimeout(run, lastRun.current ? wait : 0);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [delayMs, enabled]);
}
