import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { diffConfig, setPath, stableStringify } from '../config-path';
import { previewMatches as matchPreview } from '../preview-match';
import { titleFor } from '../views/ChangesTable';
import { allFields } from '../views/SiteForm';

const AUTOSAVE_MS = 3000;
const VALIDATE_MS = 700;
// Which draft the preview on admin-preview was built from, as this browser built it. Another device reads the
// same fact from the server's draft (previewSha).
const PREVIEW_KEY = 'dt-admin-preview';

function readPreviewRecord() {
  try {
    const raw = window.localStorage.getItem(PREVIEW_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writePreviewRecord(record) {
  try {
    window.localStorage.setItem(PREVIEW_KEY, JSON.stringify(record));
  } catch (e) {
    // Private windows can refuse storage; the bar then relies on the server's publishable flag.
  }
}

// Names this page's loaded copy of the draft to the server, which orders the copy's own saves by its edit
// count, so a save sent on hide is not refused because the save before it has not answered yet.
// getRandomValues, unlike randomUUID, also works when the admin is served over plain http.
function newWriterId() {
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// owner.name is not typed by the owner: rule R1 makes it given name + space + family name.
function withDerivedName(config, path) {
  if (path !== 'owner.givenName' && path !== 'owner.familyName') return config;
  const o = config.owner || {};
  return setPath(config, 'owner.name', [o.givenName, o.familyName].filter(Boolean).join(' '));
}

const DraftContext = createContext(null);

// The site.json draft shared by the Card and Website tabs. It lives above the routes, so switching tabs
// keeps one copy and one save queue: an edit typed just before leaving a tab is neither cancelled with
// that tab's timer nor raced by the next tab's load. It loads main and any saved draft, autosaves 3 s
// after the last edit (at once when the page is hidden), validates as the preview would, and runs
// preview, publish and restore.
function useDraftState(api) {
  const [site, setSite] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [config, setConfig] = useState(null);
  const [baseSha, setBaseSha] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [validation, setValidation] = useState({ errors: [], changes: null });
  const [previewRecord, setPreviewRecord] = useState(readPreviewRecord);
  const [, setTick] = useState(0);
  // rev counts local edits; savedRev is the last one the server has. draftRev is the server's revision of
  // the draft this page holds, sent with every write so a newer draft saved elsewhere is not overwritten.
  const rev = useRef(0);
  const savedRev = useRef(0);
  const draftRev = useRef(0);
  const writer = useRef(null);
  const latest = useRef({ config: null, baseSha: null });
  const inFlight = useRef(null);
  const again = useRef(false);
  const previewing = useRef(false);
  const timer = useRef(null);
  const loaded = useRef(false);
  const loadSeq = useRef(0);

  latest.current = { config, baseSha };

  // A background load re-reads the draft under a form that stays editable. If an edit, a save or a preview
  // happened during the request, this page's copy is the newer one and the read is dropped whole: its next
  // save still sends the rev it holds, so a draft saved elsewhere meanwhile is refused, not overwritten.
  const load = useCallback(async ({ background = false } = {}) => {
    const seq = ++loadSeq.current;
    const startRev = rev.current;
    const startDraftRev = draftRev.current;
    try {
      const s = await api.get('/admin/site');
      // A read started later holds a newer draft than this one.
      if (seq !== loadSeq.current) return;
      if (background && (rev.current !== startRev || draftRev.current !== startDraftRev || inFlight.current || previewing.current)) return;
      setSite(s);
      setLoadError(null);
      loaded.current = true;
      if (s.configured === false) return;
      const d = s.draft;
      setConfig(d ? d.config : s.config);
      setBaseSha(d ? d.baseSha : s.main && s.main.sha);
      setSavedAt(d ? d.savedAt : null);
      draftRev.current = d && Number.isInteger(d.rev) ? d.rev : 0;
      setSaveError(null);
      // The edit count starts again, so it needs an id of its own to stay increasing.
      writer.current = newWriterId();
      rev.current = 0;
      savedRev.current = 0;
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(e);
    }
  }, [api]);

  // One save at a time, always of the newest config: an edit made while a save is in flight is sent when
  // it returns, so two saves never race and an older one never lands last.
  const persist = useCallback(({ keepalive = false } = {}) => {
    if (rev.current === savedRev.current || !latest.current.config) return inFlight.current || Promise.resolve();
    if ((inFlight.current || previewing.current) && !keepalive) {
      again.current = true;
      return inFlight.current || Promise.resolve();
    }
    const target = rev.current;
    // A keepalive save does not wait for the save in flight, so draftRev can predate it; writer and seq tell
    // the server that the stored draft is this page's own.
    const body = { config: latest.current.config, baseSha: latest.current.baseSha, rev: draftRev.current, writer: writer.current, seq: target };
    const run = api
      .post('/admin/site/draft', body, keepalive ? { keepalive: true } : undefined)
      .then((r) => {
        if (Number.isInteger(r.rev)) draftRev.current = r.rev;
        savedRev.current = Math.max(savedRev.current, target);
        setSavedAt(r.savedAt || new Date().toISOString());
        setSaveError(null);
      })
      .catch((e) => {
        setSaveError(e.code === 'DRAFT_CHANGED' ? e.message : 'Draft not saved: ' + e.message);
      })
      .finally(() => {
        if (inFlight.current === run) inFlight.current = null;
        setTick((n) => n + 1);
        if (again.current && !previewing.current) {
          again.current = false;
          persist();
        }
      });
    if (!keepalive) inFlight.current = run;
    return run;
  }, [api]);

  const flush = useCallback(({ keepalive = false } = {}) => {
    clearTimeout(timer.current);
    timer.current = null;
    return persist({ keepalive });
  }, [persist]);

  const update = useCallback((path, value) => {
    rev.current += 1;
    setConfig((c) => withDerivedName(setPath(c, path, value), path));
  }, []);

  useEffect(() => {
    if (!config || rev.current === savedRev.current) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      persist();
    }, AUTOSAVE_MS);
    return undefined;
  }, [config, baseSha, persist]);

  // Leaving the page, closing the tab or switching apps would drop an edit still waiting for its timer.
  // keepalive lets the request outlive the page.
  useEffect(() => {
    const onPageHide = () => flush({ keepalive: true });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush({ keepalive: true });
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      // Logout and an expired session unmount the provider; send what is still waiting.
      clearTimeout(timer.current);
      persist({ keepalive: true });
    };
  }, [flush, persist]);

  useEffect(() => {
    if (!config || !site || site.configured === false) return undefined;
    const t = setTimeout(async () => {
      try {
        const r = await api.post('/admin/site/validate', { config, baseSha });
        setValidation({ errors: r.errors || [], changes: r.changes || null });
      } catch (e) {
        if (Array.isArray(e.errors)) setValidation({ errors: e.errors, changes: null });
      }
    }, VALIDATE_MS);
    return () => clearTimeout(t);
  }, [config, baseSha, site, api]);

  const localChanges = useMemo(() => (site && site.config && config ? diffConfig(site.config, config) : []), [site, config]);
  const changes = validation.changes || localChanges;
  const configKey = useMemo(() => (config ? stableStringify(config) : null), [config]);

  const rememberPreview = useCallback((commitSha, kind, key) => {
    const record = { commitSha, kind, key: key || null };
    writePreviewRecord(record);
    setPreviewRecord(record);
  }, []);

  const serverDraft = site && site.draft;
  const serverDraftKey = useMemo(() => (serverDraft ? stableStringify(serverDraft.config) : null), [serverDraft]);
  const serverPreviewSha = serverDraft ? serverDraft.previewSha : null;
  const hasChanges = localChanges.length > 0;
  const previewMatches = useCallback(
    (status) =>
      matchPreview({
        record: previewRecord,
        configKey,
        status,
        draft: serverPreviewSha ? { previewSha: serverPreviewSha, key: serverDraftKey } : null,
        hasChanges,
      }),
    [previewRecord, configKey, serverPreviewSha, serverDraftKey, hasChanges]
  );
  // A restore this browser built is waiting on admin-preview, but the draft holds other changes.
  const restoreBlocked = useCallback(
    (status) => {
      const head = status && status.preview && status.preview.headSha;
      return !!head && !!previewRecord && previewRecord.kind === 'restore' && previewRecord.commitSha === head && hasChanges;
    },
    [previewRecord, hasChanges]
  );

  const buildPreview = useCallback(async () => {
    // The preview carries this config, so a pending autosave of it waits; a save already sent finishes first.
    clearTimeout(timer.current);
    timer.current = null;
    if (inFlight.current) await inFlight.current;
    previewing.current = true;
    const sentRev = rev.current;
    const { config: sentConfig, baseSha: sentBase } = latest.current;
    let stale = false;
    try {
      const r = await api.post('/admin/site/preview', { config: sentConfig, baseSha: sentBase, rev: draftRev.current });
      const stored = r.draft;
      if (stored) {
        draftRev.current = stored.rev;
        setSite((s) => (s ? { ...s, draft: stored } : s));
        setSavedAt(stored.savedAt || null);
        // No edit since the request: hold what the server stored (the draft moved onto main), so this page,
        // a reload and another device all name the same preview.
        if (rev.current === sentRev) {
          setConfig(stored.config);
          setBaseSha(stored.baseSha);
          savedRev.current = rev.current;
        } else {
          savedRev.current = Math.max(savedRev.current, sentRev);
        }
      }
      rememberPreview(r.commitSha, 'draft', stableStringify(stored && rev.current === sentRev ? stored.config : sentConfig));
      return r;
    } catch (e) {
      // The server stored the rebased draft; saving this page's copy over it is what STALE prevents.
      stale = e.code === 'STALE';
      throw e;
    } finally {
      previewing.current = false;
      if (!stale && rev.current !== savedRev.current) persist();
    }
  }, [api, rememberPreview, persist]);

  const restore = useCallback(async (sha) => {
    const r = await api.post('/admin/site/revert', { sha });
    rememberPreview(r.commitSha, 'restore');
    return r;
  }, [api, rememberPreview]);

  const publish = useCallback(async (commitSha) => {
    await flush();
    const r = await api.post('/admin/site/publish', { commitSha });
    await load();
    return r;
  }, [api, load, flush]);

  const discard = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    await api.del('/admin/site/draft');
    await load();
  }, [api, load]);

  // A view coming into sight loads the draft once, then re-reads it when nothing here is unsaved, so a draft
  // saved on another device shows up without overwriting an edit made on this one.
  const refresh = useCallback(() => {
    if (!loaded.current) return load();
    if (rev.current === savedRev.current && !inFlight.current && !previewing.current) return load({ background: true });
    return Promise.resolve();
  }, [load]);

  return {
    site,
    loadError,
    configured: site ? site.configured !== false : null,
    config,
    baseSha,
    mainSha: site && site.main ? site.main.sha : null,
    savedAt,
    saveError,
    unsaved: rev.current !== savedRev.current,
    errors: validation.errors,
    changes,
    update,
    reload: load,
    refresh,
    flush,
    buildPreview,
    restore,
    publish,
    discard,
    previewMatches,
    restoreBlocked,
  };
}

export function DraftProvider({ api, children }) {
  const value = useDraftState(api);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

// Sends an edit still waiting for its autosave, for callers that are about to end the session.
export function useDraftFlush() {
  const draft = useContext(DraftContext);
  return draft ? draft.flush : null;
}

// The shared draft, loaded (or re-read) when the calling view mounts.
export default function useDraft() {
  const draft = useContext(DraftContext);
  const refresh = draft.refresh;
  useEffect(() => {
    refresh();
  }, [refresh]);
  return draft;
}

// "Tagline: 70 characters; the limit is 60." for the first few of the server's field errors.
function describeErrors(errors, site) {
  const titles = {};
  allFields(site && site.schema, site && site.fields).forEach((f) => {
    titles[f.path] = f.title || f.path;
  });
  const list = (errors || []).slice(0, 3).map((e) => titleFor(e.path, titles) + ': ' + e.message).join(' ');
  const more = (errors || []).length > 3 ? ' And ' + ((errors || []).length - 3) + ' more.' : '';
  return list + more;
}

// Preview, publish, cancel and restore share one busy flag and one error line, and each ends with a fast status
// poll, success or not, so the bar follows the GitHub run and drops an action GitHub just refused.
export function usePublishActions(api, draft, siteStatus) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const reload = draft.reload;
  const site = draft.site;

  const run = useCallback(async (kind, fn, what = kind) => {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      // A STALE preview leaves a draft rebased onto the new main on the server; load it.
      if (e.code === 'STALE') await reload();
      if (e.code === 'INVALID' && Array.isArray(e.errors) && e.errors.length) {
        const listed = describeErrors(e.errors, site);
        setError(what === 'restore'
          ? "Not restored: that version breaks today's rules. " + listed + ' Change those fields in the draft instead.'
          : 'Preview not built. ' + listed);
      } else {
        setError(e.message);
      }
      return null;
    } finally {
      setBusy(null);
      siteStatus.refresh({ fast: true });
    }
  }, [siteStatus, reload, site]);

  const status = siteStatus.status;
  return {
    busy,
    error,
    setError,
    onBuildPreview: () => run('preview', () => draft.buildPreview()),
    onPublish: () => run('publish', () => draft.publish(status && status.preview && status.preview.headSha)),
    onCancel: () => {
      const id = status && status.preview && status.preview.run && status.preview.run.id;
      return id ? run('cancel', () => api.post('/admin/site/runs/' + id + '/cancel')) : null;
    },
    onRestore: (sha) => run('preview', () => draft.restore(sha), 'restore'),
  };
}
