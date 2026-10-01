import React, { useState } from 'react';
import Heading from '../ui/Heading';
import Callout from '../ui/Callout';
import PublishBar from '../PublishBar';
import SiteForm from './SiteForm';
import CardPreview from './CardPreview';
import DraftNotes from './DraftNotes';
import useDraft, { usePublishActions } from '../hooks/useDraft';
import useSiteStatus from '../hooks/useSiteStatus';

const FORM_NOTE = (
  <Callout>
    <p>
      The form stays off until three things are true: an approved notice, a retention period, and the card-details
      section on /security/. The build refuses to publish otherwise.
    </p>
  </Callout>
);

export default function CardView({ api }) {
  const draft = useDraft(api);
  const siteStatus = useSiteStatus();
  const actions = usePublishActions(api, draft, siteStatus);
  const [mode, setMode] = useState('edit');
  const site = draft.site;
  const ready = site && site.configured !== false && draft.config;

  return (
    <>
      <div className="page-head">
        <Heading text="Card." />
        <p className="lede">What people see at donatelli.tech/card/. Edits go live after a preview passes and you publish it.</p>
      </div>
      <div className="stack section-tight">
        <DraftNotes draft={draft} status={siteStatus.status} />
      </div>
      {ready ? (
        <>
          <div className="editor-toggle section" role="group" aria-label="Show">
            <div className="seg">
              <button type="button" aria-pressed={mode === 'edit' ? 'true' : 'false'} onClick={() => setMode('edit')}>Edit</button>
              <button type="button" aria-pressed={mode === 'preview' ? 'true' : 'false'} onClick={() => setMode('preview')}>Preview</button>
            </div>
          </div>
          <div className="editor section">
            <div className={'pane' + (mode === 'edit' ? '' : ' pane-off')}>
              <SiteForm
                schema={site.schema}
                fields={site.fields}
                tab="card"
                config={draft.config}
                errors={draft.errors}
                onChange={draft.update}
                groupNotes={{ 'Send me your details': FORM_NOTE }}
              />
            </div>
            <div className={'pane preview-col' + (mode === 'preview' ? '' : ' pane-off')}>
              <p className="eyebrow">Preview</p>
              <CardPreview config={draft.config} liveOrigin={site.urls && site.urls.production} />
            </div>
          </div>
          <div className="bar-space" />
          <PublishBar
            status={siteStatus.status}
            draft={draft}
            busy={actions.busy}
            error={actions.error}
            onBuildPreview={actions.onBuildPreview}
            onPublish={actions.onPublish}
            onCancel={actions.onCancel}
          />
        </>
      ) : null}
    </>
  );
}
