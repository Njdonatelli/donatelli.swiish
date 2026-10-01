import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Heading from '../ui/Heading';
import Button from '../ui/Button';
import Dialog from '../ui/Dialog';
import { TextField } from '../ui/Field';
import Icon, { Download, Trash2 } from '../ui/Icon';
import ConnectionRows, { StatusBadge } from './ConnectionRows';
import { Metrics } from './HomeView';
import useMedia from '../hooks/useMedia';
import { countCsvRecords, formatDateTime, formatTime, mailtoHref, pluralize } from '../format';

const FILTERS = [
  ['all', 'All'],
  ['new', 'New'],
  ['contacted', 'Contacted'],
  ['archived', 'Archived'],
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function ConnectionsTable({ items }) {
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Received</th>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Company</th>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td className="mono">{formatDateTime(c.receivedAt)}</td>
              <td><Link to={'/admin/connections/' + c.id}>{c.name}</Link></td>
              <td><a href={mailtoHref(c.email)}>{c.email}</a></td>
              <td>{c.company || ''}</td>
              <td className="mono">{c.source}</td>
              <td><StatusBadge status={c.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ConnectionsView({ api }) {
  const location = useLocation();
  const navigate = useNavigate();
  const wide = useMedia('(min-width: 768px)');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [more, setMore] = useState(false);
  const [notice, setNotice] = useState((location.state && location.state.notice) || '');
  const [formOn, setFormOn] = useState(null);
  const [erase, setErase] = useState({ open: false, email: '', busy: false, error: null });
  const [exporting, setExporting] = useState(false);
  const seq = useRef(0);

  // A notice handed over by the detail view (after a delete) is shown once, not again on reload.
  useEffect(() => {
    if (location.state && location.state.notice) navigate(location.pathname, { replace: true, state: null });
  }, [location, navigate]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const url = useCallback(
    (cursor) =>
      '/admin/connections?status=' + filter + '&limit=50' +
      (query ? '&q=' + encodeURIComponent(query) : '') +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    [filter, query]
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await api.get(url());
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e.message);
    }
  }, [api, url]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .get('/admin/site')
      .then((s) => setFormOn(s.configured === false ? null : !!(s.config && s.config.card && s.config.card.connect && s.config.card.connect.enabled)))
      .catch(() => setFormOn(null));
  }, [api]);

  const showOlder = async () => {
    setMore(true);
    try {
      const d = await api.get(url(data.nextCursor));
      setData({ ...d, items: [...data.items, ...d.items] });
    } catch (e) {
      setError(e.message);
    }
    setMore(false);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { blob } = await api.download('/admin/connections/export.csv?status=' + filter, 'connections.csv');
      const n = countCsvRecords(await blob.text());
      setNotice('Exported ' + pluralize(n, 'connection', 'connections') + '.');
    } catch (e) {
      setNotice('');
      setError('Not exported: ' + e.message);
    }
    setExporting(false);
  };

  const doErase = async () => {
    const email = erase.email.trim().toLowerCase();
    setErase({ ...erase, busy: true, error: null });
    try {
      const r = await api.post('/admin/connections/erase', { email, confirm: email });
      setErase({ open: false, email: '', busy: false, error: null });
      setNotice('Erased ' + pluralize(r.count, 'record', 'records') + ' for ' + email + ' at ' + formatTime(new Date()) + '.');
      load();
    } catch (e) {
      setErase({ ...erase, busy: false, error: 'Not erased: ' + e.message });
    }
  };

  const items = (data && data.items) || [];
  const total = data && data.counts ? data.counts.total : null;
  const emptyAll = data && items.length === 0 && filter === 'all' && !query && !total;

  return (
    <>
      <div className="page-head">
        <Heading text="Connections." />
        <p className="lede">People who sent their details from the card.</p>
      </div>
      <div className="section">
        {data ? <Metrics counts={data.counts} /> : null}
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Status">
            {FILTERS.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={filter === value ? 'true' : 'false'} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <div className="cluster">
            <Button variant="secondary" icon={Download} onClick={exportCsv} busy={exporting}>Export CSV</Button>
            <Button variant="quiet" onClick={() => setErase({ open: true, email: '', busy: false, error: null })}>
              <Icon as={Trash2} size={16} /> Erase by email
            </Button>
          </div>
        </div>
        <TextField
          id="conn-search"
          label="Search name, email or company"
          type="search"
          value={search}
          maxLength={100}
          onChange={(e) => setSearch(e.target.value)}
          className="search-field"
        />
        <p className="status-msg" data-tone="ok" role="status">{notice}</p>
        {error ? <p className="status-msg" data-tone="bad" role="alert">{error}</p> : null}
        {!data && !error ? <p className="muted small">Loading connections.</p> : null}
        {emptyAll ? (
          <p className="muted">
            {formOn === false
              ? 'No connections yet. The form on the card is off; turn it on in Card → Send me your details.'
              : 'No connections yet. They appear here when someone sends details from donatelli.tech/card/.'}
          </p>
        ) : data && items.length === 0 ? (
          <p className="muted">No connections match this filter.</p>
        ) : null}
        {items.length ? (wide ? <ConnectionsTable items={items} /> : <ConnectionRows items={items} />) : null}
        {data && data.nextCursor ? (
          <div>
            <Button variant="secondary" onClick={showOlder} busy={more}>Show older</Button>
          </div>
        ) : null}
      </div>
      <Dialog
        open={erase.open}
        title="Erase by email."
        body={
          <>
            <p className="small">Every connection with this address is deleted now and cannot be restored. When backups are on, older backup files keep it until they rotate out.</p>
            <TextField
              id="erase-email"
              label="Type the email address to erase every record for it."
              type="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck="false"
              autoComplete="off"
              value={erase.email}
              onChange={(e) => setErase({ ...erase, email: e.target.value })}
            />
          </>
        }
        confirmLabel="Erase records"
        tone="danger"
        busy={erase.busy}
        error={erase.error}
        confirmDisabled={!EMAIL.test(erase.email.trim())}
        onClose={() => setErase({ open: false, email: '', busy: false, error: null })}
        onConfirm={doErase}
      />
    </>
  );
}
