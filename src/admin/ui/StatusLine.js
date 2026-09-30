import React from 'react';

// The server writes the one status sentence (lib/site-status.js); this only lays it out.
export default function StatusLine({ status }) {
  if (!status) return <p className="statusline-head muted">Checking donatelli.tech.</p>;
  const step = status.step;
  const bars = [];
  if (step && step.count) {
    for (let i = 1; i <= step.count; i++) {
      bars.push(<span key={i} className={i < step.index ? 'done' : i === step.index ? 'now' : ''} />);
    }
  }
  return (
    <div className="statusline">
      <p className="statusline-head">{status.headline}</p>
      {bars.length ? <div className="steps" aria-hidden="true">{bars}</div> : null}
      {status.detail ? <p className="statusline-detail">{status.detail}</p> : null}
    </div>
  );
}
