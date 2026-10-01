import React from 'react';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import { formatDateTime, shortSha } from '../format';

// Commits that touched data/site.json on main, newest first. The first one is what main holds now.
export default function HistoryList({ items, onRestore, disabled }) {
  if (!items) return null;
  if (!items.length) return <p className="muted small">No site.json commits found on main.</p>;
  return (
    <ol className="history">
      {items.map((h, i) => (
        <li key={h.sha}>
          <span className="subject">{h.subject}</span>
          <span className="meta">
            <span>{shortSha(h.sha)}</span>
            <span>{formatDateTime(h.date)}</span>
            <Badge tone={h.via === 'admin' ? 'info' : null}>{h.via === 'admin' ? 'Admin' : 'Git'}</Badge>
            {i === 0 ? <Badge tone="ok">On main</Badge> : null}
          </span>
          <span className="actions">
            {i > 0 ? (
              <Button variant="secondary" onClick={() => onRestore(h)} disabled={disabled}>
                Restore this version<span className="sr-only"> ({shortSha(h.sha)})</span>
              </Button>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
