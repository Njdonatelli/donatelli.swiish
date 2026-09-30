import React from 'react';

const TONES = { ok: 'b-ok', warn: 'b-warn', bad: 'b-bad', info: 'b-info', sig: 'b-sig' };

export default function Badge({ tone, children }) {
  return <span className={'badge' + (TONES[tone] ? ' ' + TONES[tone] : '')}>{children}</span>;
}
