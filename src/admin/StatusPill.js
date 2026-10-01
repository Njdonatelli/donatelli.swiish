import React from 'react';
import Badge from './ui/Badge';

const PILL = {
  live: ['ok', 'Live'],
  publishing: ['info', 'Publishing'],
  preview_building: ['info', 'Building'],
  preview_ready: ['ok', 'Preview ready'],
  preview_failed: ['bad', 'Preview failed'],
  failed: ['bad', 'Not published'],
  stalled: ['warn', 'No deploy'],
  deploys_off: ['warn', 'Deploys off'],
  rolled_back: ['warn', 'Rolled back'],
  off: [null, 'Publishing off'],
  unknown: [null, 'Unknown'],
};

export default function StatusPill({ status, error, onOpen }) {
  let [tone, label] = (status && PILL[status.state]) || [null, 'Checking'];
  let said = status && status.headline ? status.headline : 'Checking the status of donatelli.tech.';
  if (error && !status) {
    [tone, label] = ['bad', 'Not checked'];
    said = 'Status not loaded: ' + error;
  } else if (error) {
    // One failed poll after a good one keeps the last state; only the words say it may be old.
    said += ' This may be out of date: ' + error;
  }
  return (
    <button type="button" className="pill" onClick={onOpen} title={said} aria-label={'donatelli.tech: ' + said + ' Open Website.'}>
      <Badge tone={tone}>{label}</Badge>
      <span className="pill-text">donatelli.tech</span>
    </button>
  );
}
