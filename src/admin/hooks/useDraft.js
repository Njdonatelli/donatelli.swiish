import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffConfig, setPath, stableStringify } from '../config-path';

const AUTOSAVE_MS = 3000;
const VALIDATE_MS = 700;
// Which draft the preview on admin-preview was built from. Per browser: on another device the bar falls back
// to what the server reports (a green, publishable preview).
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

// owner.name is not typed by the owner: rule R1 makes it given name + space + family name.
function withDerivedName(config, path) {
  if (path !== 'owner.givenName' && path !== 'owner.familyName') return config;
  const o = config.owner || {};
  return setPath(config, 'owner.name', [o.givenName, o.familyName].filter(Boolean).join(' '));
}

// The site.json draft shared by the Card and Website tabs: loads main and any saved draft, autosaves 3 s
// after the last edit, validates against main, and runs preview, publish and restore.
export default function useDraft(api) {
  const [site, setSite] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [config, setConfig] = useState(null);
  const [baseSha, setBaseSha] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [validation, setValidation] = useState({ errors: [], changes: null });
  const [previewRecord, setPreviewRecord] = useState(readPreviewRecord);
  const rev = useRef(0);
  const savedRev = useRef(0);

  const load = useCallback(async () => {
    try {
      const s = await api.get('/admin/site');
      setSite(s);
      setLoadError(null);
      if (s.configured === false) return;
      const d = s.draft;
      setConfig(d ? d.config : s.config);
      setBaseSha(d ? d.baseSha : s.main && s.main.sha);
      setSavedAt(d ? d.savedAt : null);
      setSaveError(null);
      rev.current = 0;
      savedRev.current = 0;
    } catch (e) {
      setLoadError(e);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const update = useCallback((path, value) => {
    rev.current += 1;
    setConfig((c) => withDerivedName(setPath(c, path, value), path));
  }, []);

  useEffect(() => {
    if (!config || rev.current === savedRev.current) return undefined;
    const target = rev.current;
    const t = setTimeout(async () => {
      try {
        const r = await api.post('/admin/site/draft', { config, baseSha });
        savedRev.current = Math.max(savedRev.current, target);
        setSavedAt(r.savedAt || new Date().toISOString());
        setSaveError(null);
      } catch (e) {
        setSaveError('Draft not saved: ' + e.message);
      }
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [config, baseSha, api]);

  useEffect(() => {
    if (!config || !site || site.configured === false) return undefined;
    const t = setTimeout(async () => {
      try {
        const r = await api.post('/admin/site/validate', { config });
        setValidation({ errors: r.errors || [], changes: r.changes || null });
      } catch (e) {
        if (Array.isArray(e.errors)) setValidation({ errors: e.errors, changes: null });
      }
    }, VALIDATE_MS);
    return () => clearTimeout(t);
  }, [config, site, api]);

  const localChanges = useMemo(() => (site && site.config && config ? diffConfig(site.config, config) : []), [site, config]);
  const changes = validation.changes || localChanges;
  const configKey = useMemo(() => (config ? stableStringify(config) : null), [config]);

  const rememberPreview = useCallback((commitSha, kind, key) => {
    const record = { commitSha, kind, key: key || null };
    writePreviewRecord(record);
    setPreviewRecord(record);
  }, []);

  // Whether the preview on admin-preview is the one this draft (or a restore) produced.
  const previewMatches = useCallback((status) => {
    const head = status && status.preview && status.preview.headSha;
    if (!head) return false;
    if (previewRecord && previewRecord.commitSha === head) {
      return previewRecord.kind === 'restore' || previewRecord.key === configKey;
    }
    return !previewRecord && !!(status.preview && status.preview.publishable);
  }, [previewRecord, configKey]);

  const buildPreview = useCallback(async () => {
    const r = await api.post('/admin/site/preview', { config, baseSha });
    rememberPreview(r.commitSha, 'draft', stableStringify(config));
    return r;
  }, [api, config, baseSha, rememberPreview]);

  const restore = useCallback(async (sha) => {
    const r = await api.post('/admin/site/revert', { sha });
    rememberPreview(r.commitSha, 'restore');
    return r;
  }, [api, rememberPreview]);

  const publish = useCallback(async (commitSha) => {
    const r = await api.post('/admin/site/publish', { commitSha });
    await load();
    return r;
  }, [api, load]);

  const discard = useCallback(async () => {
    await api.del('/admin/site/draft');
    await load();
  }, [api, load]);

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
    buildPreview,
    restore,
    publish,
    discard,
    previewMatches,
  };
}

// Preview, publish, cancel and restore share one busy flag and one error line, and each ends with a fast status
// poll so the bar follows the GitHub run without a reload.
export function usePublishActions(api, draft, siteStatus) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const run = useCallback(async (kind, fn) => {
    setBusy(kind);
    setError(null);
    try {
      const out = await fn();
      await siteStatus.refresh({ fast: true });
      return out;
    } catch (e) {
      setError(e.code === 'INVALID' ? 'Preview not built: fix the fields marked in red, then build it again.' : e.message);
      return null;
    } finally {
      setBusy(null);
    }
  }, [siteStatus]);

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
    onRestore: (sha) => run('preview', () => draft.restore(sha)),
  };
}
