import React from 'react';
import Badge from '../ui/Badge';
import useMedia from '../hooks/useMedia';
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

function RunLink({ run, children }) {
  return run.htmlUrl ? (
    <a href={run.htmlUrl} target="_blank" rel="noopener noreferrer">{children}<span className="sr-only"> on GitHub</span></a>
  ) : (
    children
  );
}

// A phone gets Started, Commit and Result, with the commit linking to its run: five columns there would push
// the result, the one thing the owner came for, out of sight.
export default function RunsTable({ runs }) {
  const wide = useMedia('(min-width: 640px)');
  if (!runs) return null;
  if (!runs.length) return <p className="muted small">No workflow runs on this branch yet.</p>;
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Commit</th>
            {wide ? <th scope="col">Trigger</th> : null}
            <th scope="col">Result</th>
            {wide ? <th scope="col"><span className="sr-only">Link</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const [tone, label] = runBadge(r);
            return (
              <tr key={r.id}>
                <td className="mono">{formatDateTime(r.runStartedAt || r.createdAt)}</td>
                <td className="mono">{wide ? shortSha(r.headSha) : <RunLink run={r}>{shortSha(r.headSha)}</RunLink>}</td>
                {wide ? <td className="mono">{r.event}</td> : null}
                <td className="nowrap"><Badge tone={tone}>{label}</Badge></td>
                {wide ? (
                  <td className="nowrap">
                    {r.htmlUrl ? <RunLink run={r}>View run<span className="sr-only"> {shortSha(r.headSha)}</span></RunLink> : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
