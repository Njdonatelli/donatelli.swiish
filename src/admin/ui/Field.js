import React, { useState } from 'react';
import Icon, { Eye, EyeOff } from './Icon';

function describedBy(id, hint, error) {
  return [hint && id + '-hint', error && id + '-err'].filter(Boolean).join(' ') || undefined;
}

function Notes({ id, hint, error }) {
  return (
    <>
      {hint ? <p className="field-hint" id={id + '-hint'}>{hint}</p> : null}
      {error ? <p className="field-error" id={id + '-err'}>{error}</p> : null}
    </>
  );
}

export function TextField({ id, label, hint, error, badge, className, ...input }) {
  return (
    <div className={'field' + (className ? ' ' + className : '')}>
      <label htmlFor={id}>{label}{badge}</label>
      <input id={id} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy(id, hint, error)} {...input} />
      <Notes id={id} hint={hint} error={error} />
    </div>
  );
}

export function PasswordField({ id, label, hint, error, className, ...input }) {
  const [shown, setShown] = useState(false);
  return (
    <div className={'field' + (className ? ' ' + className : '')}>
      <label htmlFor={id}>{label}</label>
      <div className="input-group">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy(id, hint, error)}
          spellCheck="false"
          autoCapitalize="none"
          {...input}
        />
        <button
          type="button"
          className="btn btn-icon"
          aria-label={shown ? 'Hide ' + String(label).toLowerCase() : 'Show ' + String(label).toLowerCase()}
          aria-pressed={shown ? 'true' : 'false'}
          aria-controls={id}
          onClick={() => setShown(!shown)}
        >
          <Icon as={shown ? EyeOff : Eye} size={20} />
        </button>
      </div>
      <Notes id={id} hint={hint} error={error} />
    </div>
  );
}

export function TextAreaField({ id, label, hint, error, badge, className, ...input }) {
  return (
    <div className={'field' + (className ? ' ' + className : '')}>
      <label htmlFor={id}>{label}{badge}</label>
      <textarea id={id} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy(id, hint, error)} {...input} />
      <Notes id={id} hint={hint} error={error} />
    </div>
  );
}

export function SelectField({ id, label, hint, error, options, className, ...input }) {
  return (
    <div className={'field' + (className ? ' ' + className : '')}>
      <label htmlFor={id}>{label}</label>
      <select id={id} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy(id, hint, error)} {...input}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <Notes id={id} hint={hint} error={error} />
    </div>
  );
}

export function SwitchField({ id, label, hint, error, checked, onChange, disabled }) {
  return (
    <div className="field">
      <label className="switch" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={!!checked}
          disabled={disabled}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy(id, null, error)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="switch-text">
          {label}
          {hint ? <small>{hint}</small> : null}
        </span>
      </label>
      <Notes id={id} error={error} />
    </div>
  );
}

// A schema field the admin may not change: shown as text, never as a disabled input that looks editable.
export function ReadOnlyField({ label, value, mono, hint }) {
  return (
    <div className="field">
      <span className="field-label">
        {label} <span className="badge">Read-only</span>
      </span>
      <p className={'field-ro' + (mono ? ' mono' : '')}>{value}</p>
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}
