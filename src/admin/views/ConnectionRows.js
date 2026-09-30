import React from 'react';
import { Link } from 'react-router-dom';
import Badge from '../ui/Badge';
import { relativeTime } from '../format';

export const STATUS_BADGE = {
  new: ['sig', 'New'],
  contacted: ['ok', 'Contacted'],
  archived: [null, 'Archived'],
};

export function StatusBadge({ status }) {
  const [tone, label] = STATUS_BADGE[status] || [null, status];
  return <Badge tone={tone}>{label}</Badge>;
}

// The narrow-screen list: name, then company · source · age in mono, then the status badge.
export default function ConnectionRows({ items, now }) {
  return (
    <ul className="rows">
      {items.map((c) => (
        <li key={c.id}>
          <Link className="row" to={'/admin/connections/' + c.id}>
            <span className="row-title">{c.name}</span>
            <span className="row-meta">
              {[c.company, c.source, relativeTime(c.receivedAt, now)].filter(Boolean).join(' · ')}
            </span>
            <StatusBadge status={c.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
