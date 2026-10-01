import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AuthFrame from './AuthFrame';
import Button from '../ui/Button';
import { PasswordField, TextField } from '../ui/Field';
import { useSession } from '../session';
import { formatTime } from '../format';

function loginError(err) {
  if (err.status === 401) return 'Email or password did not match. Try again, or reset your password.';
  if (err.status === 429) {
    const wait = err.retryAfterSeconds || 15 * 60;
    return 'Too many attempts from this network. Try again at ' + formatTime(new Date(Date.now() + wait * 1000)) + '.';
  }
  if (err.status === 400) return 'Enter the email address and password of the admin account.';
  return err.message;
}

export default function LoginView({ api }) {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const notice = location.state && location.state.notice;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/login', { email: email.trim().toLowerCase(), password });
      const from = location.state && location.state.from;
      await session.refresh();
      navigate(from && from.indexOf('/admin') === 0 ? from : '/admin', { replace: true });
    } catch (err) {
      setError(loginError(err));
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Log in.">
      {notice ? <p className="status-msg" data-tone="ok" role="status">{notice}</p> : null}
      {session.error ? <p className="status-msg" data-tone="bad" role="alert">{session.error}</p> : null}
      <form className="stack" onSubmit={submit} noValidate={false}>
        <TextField
          id="login-email"
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
        <PasswordField
          id="login-password"
          label="Password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="status-msg" data-tone="bad" aria-live="polite">{error}</p>
        <Button type="submit" variant="primary" block busy={busy}>Log in</Button>
        <p className="small">
          <Link className="btn btn-quiet flush" to="/forgot-password">Forgot password?</Link>
        </p>
      </form>
    </AuthFrame>
  );
}
