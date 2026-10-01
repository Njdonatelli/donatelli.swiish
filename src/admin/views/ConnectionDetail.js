import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Heading from '../ui/Heading';
import Button, { ButtonLink } from '../ui/Button';
import Dialog from '../ui/Dialog';
import { SelectField, TextAreaField } from '../ui/Field';
import Icon, { ArrowLeft, Download, Mail, Trash2 } from '../ui/Icon';
import { formatDate, formatDateTime, formatTime, mailtoHref, parseDate } from '../format';

const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'archived', label: 'Archived' },
];

// Arrow keys on a closed select fire change for every option they pass; the save waits for a pause.
const STATUS_SAVE_MS = 500;

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
  // confirmed: the status the server last returned. pending: chosen here, not sent yet. seq names the
  // newest status request, so an older answer arriving last cannot set the select or the message.
  const confirmed = useRef(null);
  const pending = useRef(null);
  const statusTimer = useRef(null);
  const seq = useRef(0);
  const statusInFlight = useRef(0);
  const url = '/admin/connections/' + encodeURIComponent(id);

  useEffect(() => {
    api
      .get(url)
      .then((r) => {
        confirmed.current = r.connection.status;
        setC(r.connection);
        setNotes(r.connection.ownerNotes || '');
      })
      .catch((e) => setError(e.status === 404 || e.status === 400 ? 'This connection does not exist. It may have been deleted or erased.' : e.message));
  }, [api, url]);

  const sendStatus = useCallback(async () => {
    clearTimeout(statusTimer.current);
    statusTimer.current = null;
    const value = pending.current;
    pending.current = null;
    if (value === null || value === confirmed.current) return;
    const my = ++seq.current;
    statusInFlight.current += 1;
    try {
      const r = await api.post(url, { status: value });
      confirmed.current = r.connection.status;
      if (my === seq.current && pending.current === null) {
        setC(r.connection);
        const option = STATUS_OPTIONS.find((o) => o.value === r.connection.status);
        setStatusMsg('Marked ' + (option ? option.label.toLowerCase() : r.connection.status) + ' at ' + formatTime(new Date()) + '.');
      }
    } catch (e) {
      if (my === seq.current && pending.current === null) {
        setC((cur) => ({ ...cur, status: confirmed.current }));
        setStatusMsg('Status not saved: ' + e.message);
      }
    } finally {
      statusInFlight.current -= 1;
    }
  }, [api, url]);

  const setStatus = (value) => {
    setC((cur) => ({ ...cur, status: value }));
    setStatusMsg('');
    pending.current = value;
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(sendStatus, STATUS_SAVE_MS);
  };

  // Leaving the page within the pause still saves the status the owner chose.
  useEffect(() => () => {
    if (!statusTimer.current) return;
    clearTimeout(statusTimer.current);
    if (pending.current !== null && pending.current !== confirmed.current) {
      api.post(url, { status: pending.current }).catch(() => {});
    }
  }, [api, url]);

  const saveNotes = async (e) => {
    e.preventDefault();
    setSavingNotes(true);
    try {
      const r = await api.post(url, { ownerNotes: notes.trim() ? notes : null });
      // A status chosen or still being saved keeps the select; the notes answer may predate it.
      const statusBusy = pending.current !== null || statusInFlight.current > 0;
      if (!statusBusy) confirmed.current = r.connection.status;
      setC((cur) => ({ ...r.connection, status: statusBusy ? cur.status : r.connection.status }));
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
          <Row label="Email"><a href={mailtoHref(c.email)}>{c.email}</a></Row>
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
          <a className="btn btn-secondary" href={mailtoHref(c.email)}>
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
          onBlur={() => {
            if (statusTimer.current) sendStatus();
          }}
          className="narrow"
        />
        <p className="status-msg" role="status" data-tone={statusMsg.indexOf('not saved') !== -1 ? 'bad' : 'ok'}>{statusMsg}</p>
        <form className="stack measure" onSubmit={saveNotes}>
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
