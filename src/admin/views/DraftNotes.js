import React, { useState } from 'react';
import Button from '../ui/Button';
import Callout from '../ui/Callout';
import Dialog from '../ui/Dialog';
import { formatTime, shortSha } from '../format';

// The lines both editing tabs show above the form: publishing off, draft behind main, and autosave state.
export default function DraftNotes({ draft, status }) {
  const [discarding, setDiscarding] = useState({ open: false, busy: false, error: null });
  if (draft.loadError) {
    return (
      <Callout tone="bad" role="alert">
        <p>Site settings not loaded: {draft.loadError.message}</p>
      </Callout>
    );
  }
  if (draft.configured === false) {
    return (
      <Callout tone="warn">
        <p>{(status && status.state === 'off' && status.headline) || 'Publishing is off: SITE_GITHUB_TOKEN is not set on the admin server.'}</p>
        <p>Set the token on the admin server and restart it. The Account tab links to the token page with the right permissions.</p>
      </Callout>
    );
  }
  const stored = draft.site && draft.site.draft;
  const behind = stored && draft.baseSha && draft.mainSha && draft.baseSha !== draft.mainSha;
  // The server moved a draft that clashes with nothing onto main as it loaded it.
  const rebased = stored && stored.rebasedFrom && !behind;
  return (
    <>
      {behind ? (
        <Callout tone="warn">
          {stored.conflicts && stored.conflicts.length ? (
            <p>
              donatelli.tech changed since this draft (commit {shortSha(draft.mainSha)}), in fields this draft also
              changes. Building a preview loads that change into those fields and keeps your other edits.
            </p>
          ) : (
            <p>
              donatelli.tech changed since this draft (commit {shortSha(draft.mainSha)}). Building a preview keeps your
              changes when they touch different fields.
            </p>
          )}
        </Callout>
      ) : null}
      {rebased ? (
        <Callout tone="info">
          <p>
            donatelli.tech changed since this draft started (commit {shortSha(draft.mainSha)}). The draft now includes
            that change, and Changes lists only your own edits.
          </p>
        </Callout>
      ) : null}
      <p className="draft-line" aria-live="polite">
        {draft.saveError ? (
          <span className="field-error">{draft.saveError}</span>
        ) : draft.savedAt ? (
          <span>Draft saved {formatTime(draft.savedAt)}.</span>
        ) : (
          <span>No draft. Edits save as a draft on the admin server, so you can finish on any device.</span>
        )}
        {draft.savedAt ? (
          <Button variant="quiet" onClick={() => setDiscarding({ open: true, busy: false, error: null })}>Discard draft</Button>
        ) : null}
      </p>
      <Dialog
        open={discarding.open}
        title="Discard this draft?"
        body="The card and site facts go back to what donatelli.tech shows now. A preview that was already built stays on the preview address."
        confirmLabel="Discard draft"
        tone="danger"
        busy={discarding.busy}
        error={discarding.error}
        onClose={() => setDiscarding({ open: false, busy: false, error: null })}
        onConfirm={async () => {
          setDiscarding({ open: true, busy: true, error: null });
          try {
            await draft.discard();
            setDiscarding({ open: false, busy: false, error: null });
          } catch (e) {
            setDiscarding({ open: true, busy: false, error: 'Draft not discarded: ' + e.message });
          }
        }}
      />
    </>
  );
}
