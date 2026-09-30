import React from 'react';
import Badge from '../ui/Badge';
import { formatDateTime, shortSha } from '../format';

function runBadge(run) {
  if (run.status !== 'completed') {
    return ['info', run.status === 'in_progress' ? 'In progress' : run.status === 'queued' ? 'Queued' : run.status];
  }
  switch (run.conclusion) {
    case 'success':
      return ['ok', 'Passed'];
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return ['bad', 'Failed'];
    case 'cancelled':
      return [null, 'Cancelled'];
    case 'skipped':
      return [null, 'Skipped'];
    default:
      return [null, run.conclusion || 'Done'];
  }
}

export default function RunsTable({ runs }) {
  if (!runs) return null;
  if (!runs.length) return <p className="muted small">No workflow runs on this branch yet.</p>;
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Commit</th>
            <th scope="col">Trigger</th>
            <th scope="col">Result</th>
            <th scope="col"><span className="sr-only">Link</span></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const [tone, label] = runBadge(r);
            return (
              <tr key={r.id}>
                <td className="mono">{formatDateTime(r.runStartedAt || r.createdAt)}</td>
                <td className="mono">{shortSha(r.headSha)}</td>
                <td className="mono">{r.event}</td>
                <td className="nowrap"><Badge tone={tone}>{label}</Badge></td>
                <td className="nowrap">
                  {r.htmlUrl ? (
                    <a href={r.htmlUrl} target="_blank" rel="noopener noreferrer">View run<span className="sr-only"> {shortSha(r.headSha)} on GitHub</span></a>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
