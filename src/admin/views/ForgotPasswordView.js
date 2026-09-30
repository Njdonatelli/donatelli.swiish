import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import AuthFrame from './AuthFrame';
import Button from '../ui/Button';
import Callout from '../ui/Callout';
import { TextField } from '../ui/Field';
import { useSession } from '../session';

export default function ForgotPasswordView({ api }) {
  const session = useSession();
  const mail = !!(session.setup && session.setup.mailConfigured);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/forgot-password', { email: email.trim().toLowerCase() });
      setSent(true);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  return (
    <AuthFrame title="Reset your password.">
      {!mail ? (
        <Callout tone="warn">
          <p>Email is not set up on this server. Reset the password from the server shell:</p>
          <code className="cmd">node scripts/set-password.js &lt;email&gt;</code>
        </Callout>
      ) : sent ? (
        <p className="status-msg" data-tone="ok" role="status">If that address has an account, a reset link is on its way.</p>
      ) : (
        <form className="stack" onSubmit={submit}>
          <TextField
            id="forgot-email"
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck="false"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className="status-msg" data-tone="bad" aria-live="polite">{error}</p>
          <Button type="submit" variant="primary" block busy={busy}>Send reset link</Button>
        </form>
      )}
      <p className="small">
        <Link className="btn btn-quiet flush" to="/login">Back to log in</Link>
      </p>
    </AuthFrame>
  );
}
