import React, { useEffect, useId, useRef, useState } from 'react';
import Heading from './Heading';
import Button from './Button';
import { TextField } from './Field';

// Native <dialog>: showModal() gives focus containment, Escape and an inert page without a library.
export default function Dialog({
  open, title, body, confirmLabel, cancelLabel = 'Cancel', typedConfirm, typedConfirmLabel,
  onConfirm, onClose, tone, busy, error, confirmDisabled,
}) {
  const ref = useRef(null);
  const uid = useId();
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTyped('');
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  const blocked = busy || confirmDisabled || (typedConfirm ? typed.trim() !== typedConfirm : false);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={uid + 'title'}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      {open ? (
        <form
          className="dialog-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocked) onConfirm(typed);
          }}
        >
          <Heading level={2} text={title} id={uid + 'title'} />
          {typeof body === 'string' ? <p>{body}</p> : body}
          {typedConfirm ? (
            <TextField
              id={uid + 'typed'}
              label={typedConfirmLabel || 'Type ' + typedConfirm + ' to confirm.'}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck="false"
              autoCapitalize="characters"
            />
          ) : null}
          {error ? <p className="status-msg" data-tone="bad" role="alert">{error}</p> : null}
          <div className="dialog-actions">
            <Button variant="secondary" onClick={onClose} disabled={busy}>{cancelLabel}</Button>
            <Button
              type="submit"
              variant={tone === 'danger' ? 'secondary' : 'primary'}
              danger={tone === 'danger'}
              disabled={blocked}
              busy={busy}
            >
              {confirmLabel}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
