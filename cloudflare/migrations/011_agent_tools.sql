-- Agent plans (planning tools), project assets metadata, and runtime command jobs (GitHub Actions speed-runtime).
CREATE TABLE IF NOT EXISTS agent_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  task_id TEXT,
  title TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active', -- active | completed | abandoned
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS agent_plans_idx ON agent_plans (project_id, updated_at);

CREATE TABLE IF NOT EXISTS runtime_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operation_id TEXT,
  kind TEXT NOT NULL, -- install | build | typecheck | lint | test | format | script
  script TEXT,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | succeeded | failed | expired
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  exit_code INTEGER,
  output TEXT,
  diagnostics TEXT,
  files TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS runtime_jobs_idx ON runtime_jobs (project_id, created_at);
CREATE INDEX IF NOT EXISTS agent_knowledge_text_idx ON agent_knowledge (project_id, created_at);
