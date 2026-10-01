import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Heading from '../ui/Heading';
import Button from '../ui/Button';
import Badge from '../ui/Badge';
import { PasswordField } from '../ui/Field';
import { LogOut } from '../ui/Icon';
import ActivityList from './ActivityList';
import { useSession } from '../session';
import { daysUntil, formatDate, formatDateTime, formatTime, shortSha } from '../format';
import { readTheme, saveTheme } from '../theme';
import { SOURCE_URL, SWIISH_VERSION, TOKEN_CREATE_URL } from '../about';

const MIN_PASSWORD = 12;
const EXPIRY_WARN_DAYS = 14;

function PasswordSection({ api, session }) {
  const [form, setForm] = useState({ current: '', next: '', repeat: '' });
  const [fieldError, setFieldError] = useState({});
  const [msg, setMsg] = useState({ tone: 'ok', text: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setMsg({ tone: 'ok', text: '' });
    if (form.next.length < MIN_PASSWORD) return setFieldError({ next: 'Use at least 12 characters.' });
    if (form.next !== form.repeat) return setFieldError({ repeat: 'The two passwords differ. Type the same password twice.' });
    setFieldError({});
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: form.current, newPassword: form.next });
      setForm({ current: '', next: '', repeat: '' });
      setMsg({ tone: 'ok', text: 'Password changed at ' + formatTime(new Date()) + '. Other devices are signed out; this one stays in.' });
    } catch (err) {
      if (err.status === 401 && /^unauthori[sz]ed$/i.test(err.message)) {
        session.expire();
      } else if (err.status === 401) {
        setFieldError({ current: 'Current password did not match. Type it again.' });
      } else {
        setMsg({ tone: 'bad', text: 'Password not changed: ' + err.message });
      }
    }
    setBusy(false);
  };

  return (
    <section className="section" aria-labelledby="acc-password">
      <Heading level={2} id="acc-password" text="Password." />
      <form className="stack narrow-form" onSubmit={submit}>
        <PasswordField id="acc-current" label="Current password" autoComplete="current-password" required value={form.current} onChange={set('current')} error={fieldError.current} />
        <PasswordField id="acc-new" label="New password" autoComplete="new-password" required hint="At least 12 characters." value={form.next} onChange={set('next')} error={fieldError.next} />
        <PasswordField id="acc-repeat" label="Repeat new password" autoComplete="new-password" required value={form.repeat} onChange={set('repeat')} error={fieldError.repeat} />
        <p className="status-msg" data-tone={msg.tone} role="status">{msg.text}</p>
        <div>
          <Button type="submit" variant="primary" busy={busy}>Change password</Button>
        </div>
      </form>
    </section>
  );
}

function SessionsSection({ api, session }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signOutAll = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/logout-all');
      const notice = 'Signed out everywhere at ' + formatTime(new Date()) + '. Log in again on each device.';
      session.expire();
      navigate('/login', { replace: true, state: { notice } });
    } catch (e) {
      setError('Not signed out: ' + e.message);
      setBusy(false);
    }
  };
  return (
    <section className="section" aria-labelledby="acc-sessions">
      <Heading level={2} id="acc-sessions" text="Sessions." />
      <p className="small muted">Ends every session on every device, this one included.</p>
      <div>
        <Button variant="secondary" icon={LogOut} onClick={signOutAll} busy={busy}>Sign out everywhere</Button>
      </div>
      {error ? <p className="status-msg" data-tone="bad" role="alert">{error}</p> : null}
    </section>
  );
}

function Check({ ok, warn, label, detail }) {
  const tone = ok ? 'ok' : 'warn';
  return (
    <li>
      <div>
        <span>{label}</span>
        {detail ? <small>{detail}</small> : null}
      </div>
      <Badge tone={warn ? 'warn' : tone}>{warn ? 'Check' : ok ? 'OK' : 'Off'}</Badge>
    </li>
  );
}

function HealthSection({ api }) {
  const [h, setH] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/admin/health').then(setH).catch((e) => setError(e.message));
  }, [api]);

  let body = null;
  if (error) body = <p className="status-msg" data-tone="bad" role="alert">Health not loaded: {error}</p>;
  else if (!h) body = <p className="muted small">Checking the admin server.</p>;
  else {
    const gh = h.github || {};
    const live = h.live || {};
    const connect = h.connect || {};
    const days = daysUntil(gh.tokenExpiresAt);
    const soon = gh.expiresSoon || (days != null && days <= EXPIRY_WARN_DAYS);
    body = (
      <ul className="checklist">
        <Check ok={gh.tokenSet} label="GitHub token set" detail={gh.tokenSet ? null : <>Publishing stays off until <code>SITE_GITHUB_TOKEN</code> is set on the admin server.</>} />
        {gh.tokenSet ? <Check ok={gh.canReadRepo} label="GitHub token can read the website repository" /> : null}
        {gh.tokenExpiresAt ? (
          <li>
            <div>
              <span>GitHub token expires {formatDate(gh.tokenExpiresAt)} ({days} {days === 1 ? 'day' : 'days'})</span>
              <small>
                Make the replacement here:{' '}
                <a href={TOKEN_CREATE_URL} target="_blank" rel="noopener noreferrer">new fine-grained token</a>. Set it as{' '}
                <code>SITE_GITHUB_TOKEN</code> and restart.
              </small>
            </div>
            <Badge tone={soon ? 'warn' : 'ok'}>{soon ? 'Renew' : 'OK'}</Badge>
          </li>
        ) : gh.tokenSet ? null : (
          <li>
            <div>
              <span>Token page</span>
              <small>
                <a href={TOKEN_CREATE_URL} target="_blank" rel="noopener noreferrer">Create the fine-grained token</a> with
                Contents and Actions read and write on the website repository only.
              </small>
            </div>
            <Badge tone="warn">Off</Badge>
          </li>
        )}
        {gh.tokenSet ? <Check ok={gh.workflowFound} label={<><code>site.yml</code> workflow found on main</>} /> : null}
        {gh.tokenSet ? <Check ok={gh.rollbackWorkflowFound} label={<><code>rollback.yml</code> workflow found on main</>} /> : null}
        <Check
          ok={live.buildJsonReachable}
          label={<><code>donatelli.tech/build.json</code> answers</>}
          detail={live.liveSha ? <>Live commit <code>{shortSha(live.liveSha)}</code>.</> : null}
        />
        <Check
          ok={connect.ingestSecretSet && connect.orgFound}
          label="Card form ready on this server"
          detail={
            !connect.ingestSecretSet
              ? <><code>CONNECT_INGEST_SECRET</code> is not set, so card submissions are refused.</>
              : !connect.orgFound
                ? (
                  <>
                    Card submissions are refused: no organisation has the slug <code>{connect.orgSlug}</code>.
                    {connect.ownerOrgSlug ? <> Set <code>CONNECT_ORG_SLUG={connect.ownerOrgSlug}</code> on the admin server and restart.</> : null}
                  </>
                )
                : connect.lastReceivedAt
                  ? 'Last connection received ' + formatDateTime(connect.lastReceivedAt) + '.'
                  : 'No connection received yet.'
          }
        />
        <Check ok={h.mail && h.mail.configured} label="Email set up" detail={h.mail && h.mail.configured ? null : 'Password reset works from the server shell only.'} />
        <Check
          ok={!(h.setup && h.setup.setupTokenPresent)}
          warn={h.setup && h.setup.setupTokenPresent}
          label={<><code>SETUP_TOKEN</code> {h.setup && h.setup.setupTokenPresent ? 'is still set' : 'removed'}</>}
          detail={h.setup && h.setup.setupTokenPresent ? 'Remove it from the server environment and restart.' : null}
        />
        <Check ok={h.backups && h.backups.enabled} label="Database backups on" detail={h.backups && h.backups.enabled ? null : <>Set <code>BACKUP_INTERVAL_HOURS</code> on the admin server to turn them on.</>} />
      </ul>
    );
  }
  return (
    <section className="section" aria-labelledby="acc-health">
      <Heading level={2} id="acc-health" text="Health." />
      {body}
    </section>
  );
}

function ThemeSection() {
  const [theme, setTheme] = useState(readTheme);
  const pick = (t) => {
    saveTheme(t);
    setTheme(t);
  };
  return (
    <section className="section" aria-labelledby="acc-theme">
      <Heading level={2} id="acc-theme" text="Theme." />
      <div className="seg" role="group" aria-label="Theme">
        {[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, label]) => (
          <button key={v} type="button" aria-pressed={theme === v ? 'true' : 'false'} onClick={() => pick(v)}>{label}</button>
        ))}
      </div>
      <p className="small muted">Saved in this browser only.</p>
    </section>
  );
}

export default function AccountView({ api }) {
  const session = useSession();
  const user = session.user || {};
  return (
    <>
      <div className="page-head">
        <Heading text="Account." />
        <p className="lede">
          Signed in as <span className="mono">{user.email}</span>.
        </p>
      </div>
      <PasswordSection api={api} session={session} />
      <SessionsSection api={api} session={session} />
      <HealthSection api={api} />
      <section className="section" aria-labelledby="acc-activity">
        <Heading level={2} id="acc-activity" text="Activity." />
        <ActivityList api={api} />
      </section>
      <ThemeSection />
      <section className="section" aria-labelledby="acc-source">
        <Heading level={2} id="acc-source" text="Source." />
        <p className="small">
          Built on Swiish {SWIISH_VERSION} (AGPL-3.0) · <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source</a>
        </p>
      </section>
    </>
  );
}

