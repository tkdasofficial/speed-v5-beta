-- Internal tool system: every tool invocation (audit + operation state), named snapshots, agent decisions/learnings, project env vars.
CREATE TABLE IF NOT EXISTS tool_operations (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running | succeeded | failed | cancelled
  args TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  revision_before INTEGER,
  revision_after INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS tool_ops_project_idx ON tool_operations (project_id, created_at);
CREATE INDEX IF NOT EXISTS tool_ops_task_idx ON tool_operations (task_id, created_at);

CREATE TABLE IF NOT EXISTS tool_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tool_snapshots_idx ON tool_snapshots (project_id, created_at);

CREATE TABLE IF NOT EXISTS agent_knowledge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- decision | learning | context
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS agent_knowledge_idx ON agent_knowledge (project_id, kind, created_at);

CREATE TABLE IF NOT EXISTS project_env (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, name)
);
