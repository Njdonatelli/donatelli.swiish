import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Heading from '../ui/Heading';
import Button, { ButtonLink } from '../ui/Button';
import Dialog from '../ui/Dialog';
import { SelectField, TextAreaField } from '../ui/Field';
import Icon, { ArrowLeft, Download, Mail, Trash2 } from '../ui/Icon';
import { formatDate, formatDateTime, formatTime, parseDate } from '../format';

const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'archived', label: 'Archived' },
];

function Row({ label, children }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function ConnectionDetail({ api, id: idProp }) {
  const params = useParams();
  const id = idProp || params.id;
  const navigate = useNavigate();
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [notesMsg, setNotesMsg] = useState({ tone: 'ok', text: '' });
  const [savingNotes, setSavingNotes] = useState(false);
  const [deleting, setDeleting] = useState({ open: false, busy: false, error: null });

  useEffect(() => {
    api
      .get('/admin/connections/' + encodeURIComponent(id))
      .then((r) => {
        setC(r.connection);
        setNotes(r.connection.ownerNotes || '');
      })
      .catch((e) => setError(e.status === 404 || e.status === 400 ? 'This connection does not exist. It may have been deleted or erased.' : e.message));
  }, [api, id]);

  const setStatus = async (value) => {
    const before = c.status;
    setC({ ...c, status: value });
    setStatusMsg('');
    try {
      const r = await api.post('/admin/connections/' + encodeURIComponent(id), { status: value });
      setC(r.connection);
      const label = STATUS_OPTIONS.find((o) => o.value === value).label.toLowerCase();
      setStatusMsg('Marked ' + label + ' at ' + formatTime(new Date()) + '.');
    } catch (e) {
      setC({ ...c, status: before });
      setStatusMsg('Status not saved: ' + e.message);
    }
  };

  const saveNotes = async (e) => {
    e.preventDefault();
    setSavingNotes(true);
    try {
      const r = await api.post('/admin/connections/' + encodeURIComponent(id), { ownerNotes: notes.trim() ? notes : null });
      setC(r.connection);
      setNotesMsg({ tone: 'ok', text: 'Notes saved at ' + formatTime(new Date()) + '.' });
    } catch (err) {
      setNotesMsg({ tone: 'bad', text: 'Notes not saved: ' + err.message });
    }
    setSavingNotes(false);
  };

  const doDelete = async () => {
    setDeleting({ open: true, busy: true, error: null });
    try {
      await api.del('/admin/connections/' + encodeURIComponent(id));
      navigate('/admin/connections', { state: { notice: 'Connection deleted at ' + formatTime(new Date()) + '.' } });
    } catch (e) {
      setDeleting({ open: true, busy: false, error: 'Not deleted: ' + e.message });
    }
  };

  const saveVcard = async () => {
    try {
      await api.download('/admin/connections/' + encodeURIComponent(id) + '/contact.vcf', 'contact.vcf');
    } catch (e) {
      setStatusMsg('Contact not saved: ' + e.message);
    }
  };

  const back = (
    <ButtonLink to="/admin/connections" variant="quiet" className="flush" icon={ArrowLeft}>All connections</ButtonLink>
  );

  if (error) {
    return (
      <>
        {back}
        <div className="page-head">
          <Heading text="Connection." />
          <p className="status-msg" data-tone="bad" role="alert">{error}</p>
        </div>
      </>
    );
  }
  if (!c) {
    return (
      <>
        {back}
        <div className="page-head">
          <Heading text="Connection." />
          <p className="muted small">Loading the connection.</p>
        </div>
      </>
    );
  }

  const received = parseDate(c.receivedAt);
  return (
    <>
      {back}
      <div className="page-head">
        <Heading text="Connection." />
      </div>
      <div className="section">
        <dl className="dl">
          <Row label="Name">{c.name}</Row>
          <Row label="Email"><a href={'mailto:' + c.email}>{c.email}</a></Row>
          <Row label="Company">{c.company || <span className="muted">Not given</span>}</Row>
          <Row label="Note">{c.note || <span className="muted">Not given</span>}</Row>
          <Row label="Source"><span className="mono">{c.source}</span></Row>
          <Row label="Received"><span className="mono">{formatDateTime(received)}</span></Row>
          <Row label="Kept until">
            {formatDate(c.expiresAt)}, {c.retentionDays} days from receipt, per the notice they saw
          </Row>
          <Row label="Consent">
            <details>
              <summary>Notice they saw (version <span className="mono">{c.consentVersion}</span>)</summary>
              <p>{c.consentNotice}</p>
            </details>
          </Row>
        </dl>
        <div className="cluster">
          <a className="btn btn-secondary" href={'mailto:' + c.email}>
            <Icon as={Mail} size={16} /> Email
          </a>
          <Button variant="secondary" icon={Download} onClick={saveVcard}>Save to contacts</Button>
        </div>
      </div>
      <div className="section">
        <SelectField
          id="conn-status"
          label="Status"
          options={STATUS_OPTIONS}
          value={c.status}
          onChange={(e) => setStatus(e.target.value)}
          className="narrow"
        />
        <p className="status-msg" role="status" data-tone={statusMsg.indexOf('not saved') !== -1 ? 'bad' : 'ok'}>{statusMsg}</p>
        <form className="stack" onSubmit={saveNotes}>
          <TextAreaField
            id="conn-notes"
            label="Notes"
            hint="Only you see these. They are not sent to the visitor."
            rows={5}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <p className="status-msg" data-tone={notesMsg.tone} role="status">{notesMsg.text}</p>
          <div>
            <Button type="submit" variant="primary" busy={savingNotes}>Save notes</Button>
          </div>
        </form>
      </div>
      <div className="section">
        <div>
          <Button variant="secondary" danger icon={Trash2} onClick={() => setDeleting({ open: true, busy: false, error: null })}>
            Delete connection
          </Button>
        </div>
      </div>
      <Dialog
        open={deleting.open}
        title="Delete this connection?"
        body="The record is removed now and cannot be restored."
        confirmLabel="Delete connection"
        tone="danger"
        busy={deleting.busy}
        error={deleting.error}
        onClose={() => setDeleting({ open: false, busy: false, error: null })}
        onConfirm={doDelete}
      />
    </>
  );
}
