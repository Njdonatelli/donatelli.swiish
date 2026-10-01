import React from 'react';
import Button, { ExternalLink } from './ui/Button';
import { pluralize } from './format';

function stepText(status) {
  const s = status && status.step;
  return s ? 'Step ' + s.index + ' of ' + s.count + ': ' + s.name + '.' : '';
}

// The sticky bar on Card and Website. It holds the view's one primary action, and which one depends on where
// the draft is: unsaved changes → Build preview; green preview of this draft → Publish.
export default function PublishBar({ status, draft, onBuildPreview, onPublish, onCancel, busy, error }) {
  const count = draft && draft.changes ? draft.changes.length : 0;
  const matches = draft ? draft.previewMatches(status) : false;
  const preview = (status && status.preview) || {};
  const state = status && status.state;
  let label;
  let detail = null;
  let actions = null;

  if (busy === 'preview') {
    label = 'Building preview.';
    detail = 'Sending the draft to GitHub.';
  } else if (busy === 'publish') {
    label = 'Publishing.';
    detail = 'Moving main to the preview commit.';
  } else if (state === 'publishing') {
    label = status.headline || 'Publishing. ' + stepText(status);
  } else if (state === 'preview_building' && matches) {
    label = 'Building preview. ' + stepText(status);
    actions = preview.run && preview.run.id ? <Button variant="quiet" onClick={onCancel}>Cancel</Button> : null;
  } else if (matches && preview.publishable) {
    label = 'Preview ready.';
    detail = 'QA passed. Check it, then publish.';
    actions = (
      <>
        {preview.url ? <ExternalLink variant="quiet" href={preview.url}>Open preview</ExternalLink> : null}
        <Button variant="primary" onClick={onPublish}>Publish to donatelli.tech</Button>
      </>
    );
  } else if (matches && state === 'preview_failed') {
    label = 'Preview not built: ' + failedStep(status) + '.';
    actions = (
      <>
        {preview.run && preview.run.htmlUrl ? <ExternalLink variant="secondary" href={preview.run.htmlUrl}>View run</ExternalLink> : null}
        {count > 0 ? <Button variant="primary" onClick={onBuildPreview}>Build preview</Button> : null}
      </>
    );
  } else if (count > 0) {
    label = pluralize(count, 'change', 'changes') + '.';
    if (draft && draft.restoreBlocked && draft.restoreBlocked(status)) {
      detail = 'The preview holds a restore, not this draft. Discard the draft to publish the restore, or build a preview of the draft.';
    } else {
      detail = matches ? null : 'Build a preview to check them before publishing.';
    }
    actions = <Button variant="primary" onClick={onBuildPreview}>Build preview</Button>;
  } else {
    label = 'No changes.';
  }

  return (
    <div className="publishbar" role="region" aria-label="Publish">
      <div className="publishbar-inner">
        <p className="publishbar-label" aria-live="polite">
          {label}
          {error ? <small className="field-error" role="alert">{error}</small> : detail ? <small>{detail}</small> : null}
        </p>
        {actions ? <div className="publishbar-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

// "Preview not built: the QA check failed. Open the log, …" → "the QA check failed".
function failedStep(status) {
  const m = /not built: ([^.]+)\./i.exec((status && status.headline) || '');
  return m ? m[1] : 'a check failed';
}
