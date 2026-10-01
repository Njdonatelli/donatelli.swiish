import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import AuthFrame from './AuthFrame';
import { ButtonLink } from '../ui/Button';
import { formatTime } from '../format';
import { useSession } from '../session';

export default function VerifyEmailView({ api }) {
  const { token } = useParams();
  const session = useSession();
  const [result, setResult] = useState(null);
  const asked = useRef(false);

  useEffect(() => {
    // The token is single-use; StrictMode's double effect must not spend it twice.
    if (asked.current) return;
    asked.current = true;
    api
      .get('/auth/verify-email/' + encodeURIComponent(token))
      .then(() => setResult({ ok: true, at: new Date() }))
      .catch((err) => setResult({ ok: false, message: err.status === 400 ? null : err.message }));
  }, [api, token]);

  const next = session.status === 'authenticated' ? '/admin/account' : '/login';
  const nextLabel = session.status === 'authenticated' ? 'Open Account' : 'Log in';

  if (!result) {
    return (
      <AuthFrame title="Verify email.">
        <p className="muted" role="status">Checking the link.</p>
      </AuthFrame>
    );
  }
  if (result.ok) {
    return (
      <AuthFrame title="Email verified.">
        <p className="status-msg" data-tone="ok" role="status">Email verified at {formatTime(result.at)}.</p>
        <ButtonLink to={next} variant="primary" block>{nextLabel}</ButtonLink>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Email not verified.">
      <p className="status-msg" data-tone="bad" role="alert">
        {result.message || 'This verification link expired or was already used.'}
      </p>
      <ButtonLink to={next} variant="secondary" block>{nextLabel}</ButtonLink>
    </AuthFrame>
  );
}
