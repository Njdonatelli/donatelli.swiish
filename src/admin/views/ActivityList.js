import React, { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button';
import { formatDateTime } from '../format';
import { activitySentence } from '../activity';

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
              <th scope="col" className="fit">When</th>
              <th scope="col">What</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td className="mono">{formatDateTime(it.performedAt)}</td>
                <td>{activitySentence(it)}</td>
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
