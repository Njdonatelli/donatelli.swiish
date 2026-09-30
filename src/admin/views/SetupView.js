import React, { useState } from 'react';
import AuthFrame from './AuthFrame';
import Button from '../ui/Button';
import { PasswordField, TextField } from '../ui/Field';
import { useSession } from '../session';

const MIN_PASSWORD = 12;

export default function SetupView({ api }) {
  const session = useSession();
  const [form, setForm] = useState({ setupToken: '', organisationName: 'donatelli.tech', adminEmail: '', adminPassword: '' });
  const [error, setError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.adminPassword.length < MIN_PASSWORD) {
      setPasswordError('Use at least 12 characters.');
      return;
    }
    setPasswordError('');
    setBusy(true);
    try {
      await api.post('/setup/initialize', {
        setupToken: form.setupToken.trim(),
        organisationName: form.organisationName.trim(),
        adminEmail: form.adminEmail.trim().toLowerCase(),
        adminPassword: form.adminPassword,
      });
      await session.refresh();
    } catch (err) {
      // Another browser finished setup first: the session refresh moves this one on to the login page.
      if (err.status === 403 && !err.code) await session.refresh();
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Set up the admin.">
      <p className="small muted">This creates the one owner account. The setup token is the <code>SETUP_TOKEN</code> value on the admin server.</p>
      <form className="stack" onSubmit={submit}>
        <PasswordField
          id="setup-token"
          label="Setup token"
          autoComplete="off"
          required
          value={form.setupToken}
          onChange={set('setupToken')}
        />
        <TextField
          id="setup-org"
          label="Organisation name"
          autoComplete="organization"
          required
          maxLength={200}
          value={form.organisationName}
          onChange={set('organisationName')}
        />
        <TextField
          id="setup-email"
          label="Your email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck="false"
          required
          value={form.adminEmail}
          onChange={set('adminEmail')}
        />
        <PasswordField
          id="setup-password"
          label="Password"
          autoComplete="new-password"
          required
          hint="At least 12 characters."
          error={passwordError}
          value={form.adminPassword}
          onChange={set('adminPassword')}
        />
        <p className="status-msg" data-tone="bad" aria-live="polite">{error}</p>
        <Button type="submit" variant="primary" block busy={busy}>Create admin account</Button>
      </form>
    </AuthFrame>
  );
}
