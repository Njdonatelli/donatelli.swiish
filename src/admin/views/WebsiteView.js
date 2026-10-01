import React, { useCallback, useEffect, useState } from 'react';
import Heading from '../ui/Heading';
import StatusLine from '../ui/StatusLine';
import Button, { ExternalLink } from '../ui/Button';
import Callout from '../ui/Callout';
import Dialog from '../ui/Dialog';
import { SwitchField } from '../ui/Field';
import { ExternalLink as ExternalIcon, RefreshCw, RotateCcw } from '../ui/Icon';
import PublishBar from '../PublishBar';
import SiteForm, { allFields } from './SiteForm';
import ChangesTable from './ChangesTable';
import RunsTable from './RunsTable';
import HistoryList from './HistoryList';
import DraftNotes from './DraftNotes';
import useDraft, { usePublishActions } from '../hooks/useDraft';
import useSiteStatus from '../hooks/useSiteStatus';
import { formatDateTime, formatTime, shortSha } from '../format';

const PREVIEW_STATES = new Set(['preview_building', 'preview_ready', 'preview_failed']);

// The production state a rollback was requested against. The rollback run is not a site.yml run, so it
// leaves this key alone; a publish (new main) or a redeploy (a newer site.yml run) changes it.
function prodKey(status) {
  const p = (status && status.production) || {};
  return (p.mainSha || '') + ':' + (p.run ? p.run.id : '');
}

function runKey(status) {
  if (!status) return '';
  const r = (x) => (x && x.run ? x.run.id + ':' + x.run.status + ':' + x.run.conclusion : '-');
  return status.state + '|' + r(status.production) + '|' + r(status.preview);
}

function StatusSection({ api, site, status, error: statusError, onStartDeploy }) {
  const branches = (site && site.branches) || { production: 'main', preview: 'admin-preview' };
  const [branch, setBranch] = useState('production');
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const branchName = branches[branch];
  // Re-read the table when a run starts, moves or ends, not on every status poll.
  const key = runKey(status);

  useEffect(() => {
    api
      .get('/admin/site/runs?branch=' + encodeURIComponent(branchName))
      .then((r) => {
        setRuns(r.items || []);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [api, branchName, key]);

  const preview = (status && status.preview) || {};
  const production = (status && status.production) || {};
  const run = status && PREVIEW_STATES.has(status.state) ? preview.run : production.run;

  return (
    <section className="section" aria-labelledby="ws-status">
      <Heading level={2} id="ws-status" text="Status." />
      <StatusLine status={status} error={statusError} />
      <div className="cluster">
        {status && status.state === 'stalled' ? (
          <Button variant="secondary" icon={RefreshCw} onClick={onStartDeploy}>Start deploy</Button>
        ) : null}
        {preview.headSha && preview.url ? (
          <ExternalLink href={preview.url} variant="secondary" icon={ExternalIcon}>Open preview</ExternalLink>
        ) : null}
        {run && run.htmlUrl ? (
          <ExternalLink href={run.htmlUrl} variant="secondary" icon={ExternalIcon}>View run on GitHub</ExternalLink>
        ) : null}
        {production.url ? (
          <ExternalLink href={production.url} variant="secondary" icon={ExternalIcon}>Open donatelli.tech</ExternalLink>
        ) : null}
      </div>
      <div className="split">
        <p className="eyebrow">Workflow runs</p>
        <div className="seg" role="group" aria-label="Branch">
          <button type="button" aria-pressed={branch === 'production' ? 'true' : 'false'} onClick={() => setBranch('production')}>
            Production
          </button>
          <button type="button" aria-pressed={branch === 'preview' ? 'true' : 'false'} onClick={() => setBranch('preview')}>
            Preview
          </button>
        </div>
      </div>
      {error ? <p className="status-msg" data-tone="bad" role="alert">Runs not loaded: {error}</p> : <RunsTable runs={runs} />}
    </section>
  );
}

export default function WebsiteView({ api }) {
  const draft = useDraft(api);
  const siteStatus = useSiteStatus();
  const status = siteStatus.status;
  const actions = usePublishActions(api, draft, siteStatus);
  const [health, setHealth] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [restored, setRestored] = useState(null);
  const [restorePlan, setRestorePlan] = useState(null);
  const [rollback, setRollback] = useState({ open: false, dryRun: false, busy: false, error: null });
  const [recovery, setRecovery] = useState({ tone: 'ok', text: '', url: null });
  // Shows the rollback callout at once, until the server reports rolled_back or production moves on.
  const [rolledBack, setRolledBack] = useState(null);
  const site = draft.site;
  const ready = site && site.configured !== false && draft.config;
  const mainSha = (status && status.production && status.production.mainSha) || draft.mainSha;

  const loadHistory = useCallback(() => {
    api
      .get('/admin/site/history')
      .then((r) => {
        setHistory(r.items || []);
        setHistoryError(null);
      })
      .catch((e) => setHistoryError(e.message));
  }, [api]);

  useEffect(() => {
    api.get('/admin/health').then(setHealth).catch(() => setHealth(null));
  }, [api]);

  // The confirm shows the fields a restore would change before anything is committed.
  useEffect(() => {
    if (!restoring) return undefined;
    let live = true;
    const sha = restoring.sha;
    setRestorePlan({ sha, changes: null, error: null });
    api
      .get('/admin/site/history/' + encodeURIComponent(sha) + '/changes')
      .then((r) => live && setRestorePlan({ sha, changes: r.changes || [], error: null }))
      .catch((e) => live && setRestorePlan({ sha, changes: null, error: 'Changes not loaded: ' + e.message }));
    return () => {
      live = false;
    };
  }, [api, restoring]);

  useEffect(() => {
    if (ready) loadHistory();
  }, [ready, loadHistory, draft.mainSha]);

  const gh = (health && health.github) || {};
  const siteWorkflowMissing = health ? gh.workflowFound === false : false;
  const rollbackMissing = health ? gh.rollbackWorkflowFound === false : false;

  const redeploy = async () => {
    setRecovery({ tone: 'ok', text: '', url: null });
    try {
      const r = await api.post('/admin/site/redeploy');
      setRecovery({ tone: 'ok', text: 'Redeploy started at ' + formatTime(new Date()) + '.', url: r.htmlUrl });
      siteStatus.refresh({ fast: true });
    } catch (e) {
      setRecovery({ tone: 'bad', text: 'Redeploy not started: ' + e.message, url: null });
    }
  };

  const doRollback = async () => {
    setRollback({ ...rollback, busy: true, error: null });
    try {
      const r = await api.post('/admin/site/rollback', { confirm: 'ROLL BACK', dryRun: rollback.dryRun });
      setRollback({ open: false, dryRun: false, busy: false, error: null });
      if (rollback.dryRun) {
        setRecovery({ tone: 'ok', text: 'Rollback plan requested at ' + formatTime(new Date()) + '. The run summary lists the target; nothing changed.', url: r.htmlUrl });
      } else {
        setRolledBack(prodKey(status));
        setRecovery({ tone: 'ok', text: 'Rollback started at ' + formatTime(new Date()) + '.', url: r.htmlUrl });
      }
      siteStatus.refresh({ fast: true });
    } catch (e) {
      setRollback({ ...rollback, busy: false, error: 'Not rolled back: ' + e.message });
    }
  };

  const doRestore = async () => {
    const target = restoring;
    setRestoring(null);
    const r = await actions.onRestore(target.sha);
    if (r) setRestored({ sha: target.sha, changes: r.changes || [] });
  };

  const showRolledBack = (status && status.state === 'rolled_back') || (rolledBack !== null && rolledBack === prodKey(status));
  const plan = restoring && restorePlan && restorePlan.sha === restoring.sha ? restorePlan : null;

  return (
    <>
      <div className="page-head">
        <Heading text="Website." />
        <p className="lede">Status, changes and recovery for donatelli.tech. Every change is built and checked on a preview before it goes live.</p>
      </div>
      <div className="stack section-tight">
        <DraftNotes draft={draft} status={status} />
      </div>
      {(status || siteStatus.error) && (!status || status.configured !== false) && draft.configured !== false ? (
        <StatusSection api={api} site={site} status={status} error={siteStatus.error} onStartDeploy={redeploy} />
      ) : null}
      {ready ? (
        <>
          <section className="section" aria-labelledby="ws-changes">
            <Heading level={2} id="ws-changes" text="Changes." />
            <ChangesTable changes={draft.changes} errors={draft.errors} fields={allFields(site.schema, site.fields)} />
          </section>
          <section className="section" aria-labelledby="ws-facts">
            <Heading level={2} id="ws-facts" text="Site facts." />
            <p className="small muted">Shared by every page of donatelli.tech. The card's own details are on the Card tab.</p>
            <SiteForm
              schema={site.schema}
              fields={site.fields}
              tab="website"
              config={draft.config}
              errors={draft.errors}
              onChange={draft.update}
              groupAs="eyebrow"
            />
          </section>
          <section className="section" aria-labelledby="ws-history">
            <Heading level={2} id="ws-history" text="History." />
            <p className="small muted">Restoring a version builds a new preview from it. Nothing goes live until you publish that preview.</p>
            {restored ? (
              <Callout tone="info" role="status">
                <p>Restore of {shortSha(restored.sha)} sent to the preview. It changes these fields against main:</p>
                <ChangesTable changes={restored.changes} fields={allFields(site.schema, site.fields)} draftLabel="Restored" />
              </Callout>
            ) : null}
            {historyError ? (
              <p className="status-msg" data-tone="bad" role="alert">History not loaded: {historyError}</p>
            ) : (
              <HistoryList items={history} onRestore={setRestoring} disabled={!!actions.busy} />
            )}
          </section>
        </>
      ) : null}
      <section className="section" aria-labelledby="ws-recovery">
        <Heading level={2} id="ws-recovery" text="Recovery." />
        <p className="small muted">
          Redeploy runs the site workflow on main again. Roll back points donatelli.tech at the previous production
          deployment on Cloudflare; git stays as it is.
        </p>
        {siteWorkflowMissing || rollbackMissing ? (
          <Callout tone="warn">
            <p>
              {siteWorkflowMissing ? <>Redeploy is off: <code>.github/workflows/site.yml</code> is not on main. </> : null}
              {rollbackMissing ? <>Roll back is off: <code>.github/workflows/rollback.yml</code> is not on main. </> : null}
              Merge the website branch that adds them, then reload this page.
            </p>
          </Callout>
        ) : null}
        {showRolledBack ? (
          <Callout tone="warn">
            <p>
              Production serves an older deployment. main still holds {shortSha(mainSha) || 'a newer commit'}; restore a
              version or the next publish redeploys it.
            </p>
          </Callout>
        ) : null}
        <div className="cluster">
          <Button variant="secondary" icon={RefreshCw} onClick={redeploy} disabled={siteWorkflowMissing || draft.configured === false}>
            Redeploy live site
          </Button>
          <Button
            variant="secondary"
            danger
            icon={RotateCcw}
            disabled={rollbackMissing || draft.configured === false}
            onClick={() => setRollback({ open: true, dryRun: false, busy: false, error: null })}
          >
            Roll back production
          </Button>
        </div>
        <p className="status-msg" data-tone={recovery.tone} role="status">
          {recovery.text}{' '}
          {recovery.url ? <a href={recovery.url} target="_blank" rel="noopener noreferrer">View run on GitHub</a> : null}
        </p>
      </section>
      {ready ? (
        <>
          <div className="bar-space" />
          <PublishBar
            status={status}
            draft={draft}
            busy={actions.busy}
            error={actions.error}
            onBuildPreview={actions.onBuildPreview}
            onPublish={actions.onPublish}
            onCancel={actions.onCancel}
          />
        </>
      ) : null}
      <Dialog
        open={!!restoring}
        title="Restore this version?"
        body={
          restoring ? (
            <>
              <p>
                Builds a new preview of donatelli.tech as it was at {shortSha(restoring.sha)} ("{restoring.subject}",{' '}
                {formatDateTime(restoring.date)}). Read-only fields keep today's values. Nothing goes live until you publish
                that preview.
              </p>
              {!plan || (!plan.changes && !plan.error) ? (
                <p className="muted small" role="status">Reading the fields this version changes.</p>
              ) : plan.changes && plan.changes.length === 0 ? (
                <p>Nothing to restore: that version matches donatelli.tech.</p>
              ) : plan.changes ? (
                <>
                  <p>It changes these fields against main:</p>
                  <ChangesTable changes={plan.changes} fields={allFields(site.schema, site.fields)} draftLabel="Restored" />
                </>
              ) : null}
              {draft.changes && draft.changes.length ? (
                <p>
                  Your draft ({draft.changes.length === 1 ? '1 change' : draft.changes.length + ' changes'}) is not in this
                  preview. To publish the restore, discard the draft first; or keep editing and build a preview of the draft.
                </p>
              ) : null}
            </>
          ) : null
        }
        error={plan && plan.error}
        confirmDisabled={!plan || !plan.changes || plan.changes.length === 0}
        confirmLabel="Build preview of this version"
        onClose={() => setRestoring(null)}
        onConfirm={doRestore}
      />
      <Dialog
        open={rollback.open}
        title="Roll back production?"
        body={
          <>
            <p>
              Cloudflare switches donatelli.tech to the newest production deployment of an older commit than the one
              live now. main keeps the newer commit, so the next publish or redeploy puts it back.
            </p>
            <SwitchField
              id="rollback-dry"
              label="Only show the plan"
              hint="The run lists the target deployment and changes nothing."
              checked={rollback.dryRun}
              onChange={(v) => setRollback({ ...rollback, dryRun: v })}
            />
          </>
        }
        typedConfirm="ROLL BACK"
        confirmLabel={rollback.dryRun ? 'Request the rollback plan' : 'Roll back production'}
        tone="danger"
        busy={rollback.busy}
        error={rollback.error}
        onClose={() => setRollback({ open: false, dryRun: false, busy: false, error: null })}
        onConfirm={doRollback}
      />
    </>
  );
}
