-- Generic multi-account integration connections (Supabase, Google services, future providers).
-- GitHub keeps its existing github_connections table (sign-in + repo access) and is surfaced alongside these.
DROP TABLE IF EXISTS provider_connections;
CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration TEXT NOT NULL,          -- e.g. supabase, google_drive, google_gmail
  provider TEXT NOT NULL,             -- e.g. supabase, google
  external_account_id TEXT NOT NULL,  -- derived from the provider, never from the browser
  account_label TEXT,
  scope TEXT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  access_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- active | reconnect_required
  metadata TEXT,                      -- safe JSON shown in the UI (no secrets)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  UNIQUE (user_id, integration, external_account_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_connections_user ON integration_connections(user_id, integration);

DROP TABLE IF EXISTS oauth_states;
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  integration TEXT NOT NULL,
  origin TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
