import React from 'react';

function titleFor(path, titles) {
  if (titles[path]) return titles[path];
  // card.links.0.url → the list's title plus the item number.
  const m = /^(.*)\.(\d+)(?:\.(\w+))?$/.exec(path);
  if (m && titles[m[1]]) return titles[m[1]] + ' ' + (Number(m[2]) + 1) + (m[3] ? ', ' + m[3] : '');
  return path;
}

export function formatValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (Array.isArray(v)) {
    if (!v.length) return null;
    return v.map((x) => (x && typeof x === 'object' ? [x.label, x.url].filter(Boolean).join(': ') : String(x))).join(', ');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function Value({ v }) {
  const s = formatValue(v);
  return s === null ? <span className="muted">Empty</span> : <span>{s}</span>;
}

// Field | Now | Draft, from the server's diff against main, with each field's error beside its draft value.
export default function ChangesTable({ changes, errors, fields, draftLabel = 'Draft' }) {
  const titles = {};
  (fields || []).forEach((f) => {
    titles[f.path] = f.title || f.path;
  });
  const list = changes || [];
  const errs = errors || [];
  const shown = new Set();
  const errorFor = (path) =>
    errs.filter((e) => e.path === path || e.path.indexOf(path + '.') === 0).map((e) => {
      shown.add(e);
      return (e.path === path ? '' : titleFor(e.path, titles) + ': ') + e.message;
    });

  const rows = list.map((c) => ({ c, messages: errorFor(c.path) }));
  const rest = errs.filter((e) => !shown.has(e));

  return (
    <>
      {rows.length ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Now</th>
                <th scope="col">{draftLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ c, messages }) => (
                <tr key={c.path}>
                  <td>{titleFor(c.path, titles)}</td>
                  <td><Value v={c.from} /></td>
                  <td>
                    <Value v={c.to} />
                    {messages.map((m, i) => (
                      <span key={i} className="field-error">{' '}{m}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No changes. The draft matches donatelli.tech.</p>
      )}
      {rest.length ? (
        <ul className="stack-sm" aria-label="Other problems">
          {rest.map((e, i) => (
            <li key={i} className="field-error">
              {titleFor(e.path, titles)}: {e.message}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
