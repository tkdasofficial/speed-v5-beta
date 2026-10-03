ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_change_log_user ON change_log(user_id, seq);
CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'inactive',
  current_period_end INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
