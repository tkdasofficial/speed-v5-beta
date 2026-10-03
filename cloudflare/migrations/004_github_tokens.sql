-- Per-user GitHub OAuth tokens (encrypted with AES-GCM using a key derived from AUTH_SECRET).
CREATE TABLE IF NOT EXISTS github_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_user_id TEXT NOT NULL,
  login TEXT,
  scope TEXT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  access_expires_at INTEGER,
  refresh_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
