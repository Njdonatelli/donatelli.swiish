import React from 'react';
import Wordmark from '../ui/Wordmark';
import Heading from '../ui/Heading';
import { SOURCE_URL } from '../about';

// Login, setup and password pages: the ground, one elev-1 panel, the wordmark and the source notice.
export default function AuthFrame({ title, children }) {
  return (
    <main className="auth" id="main">
      <div className="auth-panel">
        <div className="auth-brand">
          <Wordmark />
          <p className="eyebrow">Admin</p>
        </div>
        <Heading level={1} text={title} />
        {children}
      </div>
      <p className="auth-foot">
        Built on Swiish (AGPL-3.0) · <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source</a>
      </p>
    </main>
  );
}
