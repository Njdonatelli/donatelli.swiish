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

    const run = async () => {
      timer = null;
      if (stopped || document.hidden) return;
      lastRun.current = Date.now();
      try {
        await fnRef.current();
      } finally {
        if (!stopped && !document.hidden) timer = setTimeout(run, delayMs);
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = null;
      } else if (!timer) {
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
