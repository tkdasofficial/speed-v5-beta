-- Global background task system: one row per long-running operation, plus its ordered event log.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | retrying | completed | failed | cancelled
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}',      -- handler-owned progress between steps (resumable)
  progress REAL NOT NULL DEFAULT 0,
  current_step TEXT,
  result TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  heartbeat TEXT,
  idempotency_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_idem_idx ON tasks (user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks (user_id, status, created_at);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id, created_at);

CREATE TABLE IF NOT EXISTS task_events (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, seq)
);
