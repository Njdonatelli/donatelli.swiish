import React from 'react';

export default function Callout({ tone, role, children }) {
  return (
    <div className={'callout' + (tone && tone !== 'info' ? ' ' + tone : '')} role={role}>
      {children}
    </div>
  );
}
