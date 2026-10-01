import React from 'react';
import { Link } from 'react-router-dom';

export default function Wordmark({ to }) {
  const inner = (
    <>
      donatelli<em>.</em>
      <span className="tld">tech</span>
    </>
  );
  if (to) {
    return (
      <Link className="wm" to={to} aria-label="donatelli.tech admin, overview">
        {inner}
      </Link>
    );
  }
  return (
    <span className="wm" role="img" aria-label="donatelli.tech">
      {inner}
    </span>
  );
}
