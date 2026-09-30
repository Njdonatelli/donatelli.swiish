import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AuthFrame from './AuthFrame';
import Button, { ButtonLink } from '../ui/Button';
import { PasswordField } from '../ui/Field';
import { formatTime } from '../format';

const MIN_PASSWORD = 12;

export default function ResetPasswordView({ api }) {
  const { token } = useParams();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [fieldError, setFieldError] = useState({});
  const [error, setError] = useState('');
  const [doneAt, setDoneAt] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD) return setFieldError({ password: 'Use at least 12 characters.' });
    if (password !== repeat) return setFieldError({ repeat: 'The two passwords differ. Type the same password twice.' });
    setFieldError({});
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDoneAt(new Date());
    } catch (err) {
      setError(
        err.status === 400
          ? 'Password not changed: this reset link expired or was already used. Request a new link.'
          : err.message
      );
    }
    setBusy(false);
  };

  if (doneAt) {
    return (
      <AuthFrame title="Password changed.">
        <p className="status-msg" data-tone="ok" role="status">
          Password changed at {formatTime(doneAt)}. Log in with the new password.
        </p>
        <ButtonLink to="/login" variant="primary" block>Log in</ButtonLink>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Set a new password.">
      <form className="stack" onSubmit={submit}>
        <PasswordField
          id="reset-password"
          label="New password"
          autoComplete="new-password"
          required
          hint="At least 12 characters."
          error={fieldError.password}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <PasswordField
          id="reset-repeat"
          label="Repeat password"
          autoComplete="new-password"
          required
          error={fieldError.repeat}
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
        <p className="status-msg" data-tone="bad" aria-live="polite">{error}</p>
        <Button type="submit" variant="primary" block busy={busy}>Set new password</Button>
      </form>
      <p className="small">
        <Link className="btn btn-quiet flush" to="/forgot-password">Request a new link</Link>
      </p>
    </AuthFrame>
  );
}
