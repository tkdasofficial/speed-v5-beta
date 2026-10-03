-- One-time codes for email verification (8-digit OTP) and password reset (link token). Only hashes are stored.
CREATE TABLE IF NOT EXISTS email_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_user ON email_codes(user_id, purpose);

-- Dedupe/idempotency for sent notifications (no message bodies stored).
CREATE TABLE IF NOT EXISTS email_log (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
