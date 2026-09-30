import React from 'react';
import '../card-preview.css';
import Icon, { Calendar, Mail, UserPlus } from '../ui/Icon';
import { splitTerminalMark } from '../dot';

const KNOWN_HOSTS = { 'linkedin.com': 'LinkedIn', 'github.com': 'GitHub' };

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

// Same labels as the site's tools/vcard.mjs linkLabel: a known host names itself, the site's own origin is
// "Website", anything else keeps the owner's label.
function linkLabel(url, origin, fallback) {
  const host = hostOf(url);
  if (host && host === hostOf(origin)) return 'Website';
  return KNOWN_HOSTS[host] || fallback || host;
}

const bareUrl = (u) => String(u).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

function Dotted({ text }) {
  const { head, mark, cls } = splitTerminalMark(text);
  return (
    <>
      {head}
      {mark ? <span className={cls}>{mark}</span> : null}
    </>
  );
}

// The card layout contract (spec §2.2), drawn from the draft. Links and buttons are inert text: this is a
// picture of the card, and only the page's own publish bar acts. "Build preview" produces the exact page.
export default function CardPreview({ config, liveOrigin, slogan = 'You own the software. I make it do its job.' }) {
  if (!config) return null;
  const owner = config.owner || {};
  const card = config.card || {};
  const connect = card.connect || {};
  const origin = liveOrigin || '';
  const links = [
    { label: 'Website', url: origin + '/' },
    ...(config.ownerSameAs || []).map((url) => ({ url, label: linkLabel(url, origin) })),
    ...(card.links || []).map((l) => ({ url: l.url, label: linkLabel(l.url, origin, l.label) })),
  ].filter((l) => l.url);
  const notice = connect.notice
    ? connect.notice + (connect.retentionDays ? ' Kept for ' + connect.retentionDays + ' days, then deleted.' : '')
    : null;

  return (
    <section className="card-preview" aria-label="Card preview">
      <div className="cp-page">
        <div className="cp-id">
          {origin && owner.photoSmall ? (
            <img
              className="cp-photo"
              src={origin + owner.photoSmall}
              srcSet={origin + owner.photoSmall + ' 400w' + (owner.photo ? ', ' + origin + owner.photo + ' 800w' : '')}
              sizes="96px"
              width="800"
              height="800"
              alt={owner.name ? owner.name + ', portrait' : ''}
            />
          ) : null}
          <p className="cp-eyebrow">
            <b>{config.name}</b> <span>Contact card</span>
          </p>
          <p className="cp-name">
            <Dotted text={(owner.name || '') + '.'} />
          </p>
          <p className="cp-title">{owner.jobTitle}</p>
          <p className="cp-loc">
            {owner.city}, {owner.region}
          </p>
          <p className="cp-lede">{card.lede || slogan}</p>
        </div>
        <div className="cp-actions">
          <span className="cp-btn cp-btn--primary">
            <Icon as={UserPlus} />
            Save contact
          </span>
          {config.contactEmail ? (
            <span className="cp-btn cp-btn--secondary">
              <Icon as={Mail} />
              Email
            </span>
          ) : null}
          {config.bookingUrl ? (
            <span className="cp-btn cp-btn--secondary">
              <Icon as={Calendar} />
              Book an intro call
            </span>
          ) : null}
        </div>
        <dl className="cp-list">
          {links.map((l, i) => (
            <div key={i}>
              <dt>{l.label}</dt>
              <dd>{bareUrl(l.url)}</dd>
            </div>
          ))}
        </dl>
        {connect.enabled ? (
          <div className="cp-section">
            <p className="cp-h2">
              <Dotted text="Send me your details." />
            </p>
            {connect.intro ? <p className="cp-intro">{connect.intro}</p> : null}
            <div className="cp-form" aria-hidden="true">
              <div className="cp-field">Name <span className="cp-input" /></div>
              <div className="cp-field">Email <span className="cp-input" /></div>
              <div className="cp-field">Company (optional) <span className="cp-input" /></div>
              <div className="cp-field">What is slow right now? (optional) <span className="cp-input cp-input--area" /></div>
            </div>
            <p className="cp-notice">
              {notice || 'The privacy notice appears here.'} <span>How I handle your data</span>
            </p>
            <span className="cp-btn cp-btn--secondary">Send my details</span>
          </div>
        ) : null}
        {card.showQr ? (
          <div className="cp-section">
            <p className="cp-h2">
              <Dotted text="Share this card." />
            </p>
            <div className="cp-qr">
              <img src="/api/admin/card/qr.svg?via=qr" alt={'QR code for ' + bareUrl(origin) + '/card/'} width="232" height="232" />
            </div>
            <p className="cp-muted">{bareUrl(origin)}/card/</p>
            <p className="cp-offline">Offline contact QR</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
