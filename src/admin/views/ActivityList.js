import React, { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button';
import { formatDateTime, shortSha } from '../format';

// Audit rows carry no personal data (spec §4.7), so the sentences here never name a visitor.
const SENTENCES = {
  connection_created: (d) => 'Connection received' + (d && d.source ? ' (source: ' + d.source + ')' : '') + '.',
  connection_updated: (d) =>
    d && d.to && d.to.status ? 'Connection marked ' + d.to.status + '.' : 'Connection notes updated.',
  connection_deleted: () => 'Connection deleted.',
  connection_vcard_exported: () => 'Connection saved as a contact.',
  connections_exported: (d) => 'Connections exported' + (d && d.count != null ? ' (' + d.count + ')' : '') + '.',
  connections_erased: (d) => 'Erased by email' + (d && d.count != null ? ' (' + d.count + ' records)' : '') + '.',
  connections_purged: (d) => 'Expired connections deleted' + (d && d.count != null ? ' (' + d.count + ')' : '') + '.',
  setup_completed: () => 'Admin set up.',
  sessions_revoked: () => 'Signed out everywhere.',
  password_changed: () => 'Password changed.',
  password_reset: () => 'Password reset by email link.',
  password_reset_cli: () => 'Password reset from the server shell.',
  site_preview_created: (d) => 'Preview built' + (d && d.commit ? ' (' + shortSha(d.commit) + ')' : '') + '.',
  site_reverted: (d) => 'Earlier version sent to preview' + (d && d.commit ? ' (' + shortSha(d.commit) + ')' : '') + '.',
  site_published: (d) => 'Published to donatelli.tech' + (d && d.commit ? ' (' + shortSha(d.commit) + ')' : '') + '.',
  site_run_rerun: () => 'Workflow run restarted.',
  site_run_cancelled: () => 'Workflow run cancelled.',
  site_redeploy_requested: () => 'Redeploy requested.',
  site_rollback_requested: (d) => (d && d.dryRun ? 'Rollback plan requested.' : 'Rollback requested.'),
};

function sentence(item) {
  const fn = SENTENCES[item.eventType];
  if (fn) return fn(item.data || {});
  return item.eventType.replace(/_/g, ' ') + '.';
}

export default function ActivityList({ api }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);

  // Pages by the last row's time and id: several rows can share one second, and the time alone would skip them.
  const load = useCallback(async (last) => {
    setBusy(true);
    try {
      const r = await api.get('/admin/audit?limit=20' + (last ? '&before=' + encodeURIComponent(last.performedAt) + '&before_id=' + encodeURIComponent(last.id) : ''));
      const next = r.items || [];
      setItems((prev) => (last && prev ? [...prev, ...next] : next));
      setMore(next.length === 20);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !items) return <p className="status-msg" data-tone="bad" role="alert">Activity not loaded: {error}</p>;
  if (!items) return <p className="muted small">Loading activity.</p>;
  if (!items.length) return <p className="muted small">No activity yet.</p>;
  return (
    <>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td className="mono">{formatDateTime(it.performedAt)}</td>
                <td>{sentence(it)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more ? (
        <div>
          <Button variant="secondary" busy={busy} onClick={() => load(items[items.length - 1])}>Show older</Button>
        </div>
      ) : null}
    </>
  );
}
