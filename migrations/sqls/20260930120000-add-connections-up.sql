CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  company TEXT CHECK (company IS NULL OR length(company) <= 120),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  source TEXT NOT NULL DEFAULT 'card' CHECK (source IN ('card','nfc','qr','link')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','archived')),
  owner_notes TEXT CHECK (owner_notes IS NULL OR length(owner_notes) <= 2000),
  consent_version TEXT NOT NULL CHECK (length(consent_version) = 8),
  consent_notice TEXT NOT NULL CHECK (length(consent_notice) BETWEEN 1 AND 1000),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 30 AND 1825),
  expires_at DATETIME NOT NULL,
  ip_hash TEXT CHECK (ip_hash IS NULL OR length(ip_hash) = 16),
  submitted_at DATETIME NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_connections_org_received ON connections(organisation_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_connections_org_status ON connections(organisation_id, status);
CREATE INDEX IF NOT EXISTS idx_connections_org_email ON connections(organisation_id, email);
CREATE INDEX IF NOT EXISTS idx_connections_iphash_received ON connections(ip_hash, received_at);
CREATE INDEX IF NOT EXISTS idx_connections_expires ON connections(expires_at);
