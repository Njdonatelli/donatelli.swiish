import React, { useEffect, useState } from 'react';
import Heading from '../ui/Heading';
import StatusLine from '../ui/StatusLine';
import { ButtonLink, ExternalLink } from '../ui/Button';
import { ExternalLink as ExternalIcon } from '../ui/Icon';
import useSiteStatus from '../hooks/useSiteStatus';
import ConnectionRows from './ConnectionRows';

function Metrics({ counts }) {
  const c = counts || {};
  return (
    <div className="metrics">
      <div className="metric"><span className="k">New</span><span className="v">{c.new ?? 0}</span></div>
      <div className="metric"><span className="k">Today</span><span className="v">{c.today ?? 0}</span></div>
      <div className="metric"><span className="k">This week</span><span className="v">{c.week ?? 0}</span></div>
    </div>
  );
}

export { Metrics };

export default function HomeView({ api }) {
  const { status } = useSiteStatus();
  const [conn, setConn] = useState(null);
  const [error, setError] = useState(null);
  const [qrFailed, setQrFailed] = useState(false);
  const live = status && status.production && status.production.url;

  useEffect(() => {
    api.get('/admin/connections?limit=3').then(setConn).catch((e) => setError(e.message));
  }, [api]);

  return (
    <>
      <div className="page-head">
        <Heading text="Overview." />
      </div>
      <div className="overview-grid section">
        <div className="stack-lg">
          <section className="stack" aria-label="donatelli.tech status">
            <p className="eyebrow">donatelli.tech</p>
            <StatusLine status={status} />
            <div className="cluster">
              <ButtonLink to="/admin/website" variant="secondary">Open Website</ButtonLink>
              {live ? <ExternalLink href={live} variant="secondary" icon={ExternalIcon}>Open donatelli.tech</ExternalLink> : null}
            </div>
          </section>
          <section className="section" aria-labelledby="ov-conn">
            <Heading level={2} id="ov-conn" text="New connections." />
            {error ? <p className="status-msg" data-tone="bad" role="alert">Connections not loaded: {error}</p> : null}
            {conn ? (
              <>
                <Metrics counts={conn.counts} />
                {conn.items && conn.items.length ? (
                  <ConnectionRows items={conn.items} />
                ) : (
                  <p className="muted small">No connections yet.</p>
                )}
              </>
            ) : null}
            <div className="cluster">
              <ButtonLink to="/admin/connections" variant="secondary">View all connections</ButtonLink>
            </div>
          </section>
        </div>
        <section className="section" aria-labelledby="ov-card">
          <Heading level={2} id="ov-card" text="Your card." />
          {qrFailed ? (
            <p className="muted small">QR code not shown: the admin server could not draw it. Check Health in Account.</p>
          ) : (
            <div className="qr-frame">
              <img
                src="/api/admin/card/qr.svg?via=qr"
                width="160"
                height="160"
                alt="QR code that opens donatelli.tech/card/"
                onError={() => setQrFailed(true)}
              />
            </div>
          )}
          {live ? (
            <p className="small muted">
              The code opens <span className="mono">{live}/card/?via=qr</span>. For an NFC tag, write{' '}
              <span className="mono">{live}/card/?via=nfc</span>.
            </p>
          ) : null}
          <div className="cluster">
            {live ? <ExternalLink href={live + '/card/'} variant="secondary" icon={ExternalIcon}>Open donatelli.tech/card/</ExternalLink> : null}
            <ButtonLink to="/admin/card" variant="secondary">Edit card</ButtonLink>
          </div>
        </section>
      </div>
    </>
  );
}
