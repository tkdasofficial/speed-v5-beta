-- Account connections (not sign-in) for third-party providers such as Supabase.
-- Tokens are AES-GCM encrypted by cloudflare/security/connections.server.ts.
CREATE TABLE IF NOT EXISTS provider_connections (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT,
  scope TEXT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT,
  access_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);

-- Short-lived OAuth state for connect flows (PKCE verifier never leaves the Worker).
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  origin TEXT NOT NULL,
  verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
