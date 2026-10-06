-- Agent D1: runtime state only (runs, steps, messages, tool-call history, checkpoints, AI usage).
-- Never stores project source, Drive files, binaries, secrets, raw large outputs or tool code — references/summaries only.
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  parent_run_id TEXT,
  task_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | verifying | completed | failed | cancelled
  current_stage TEXT,
  current_step_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  failure_reason TEXT,
  final_summary_status TEXT NOT NULL DEFAULT 'pending', -- pending | generated | failed | skipped
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS agent_runs_project_idx ON agent_runs (project_id, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs (user_id, status, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs (parent_run_id);

CREATE TABLE IF NOT EXISTS agent_steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  parent_step_id TEXT,
  sequence INTEGER NOT NULL,
  step_type TEXT NOT NULL, -- analyze | batch | edit | build | test | verify | recover | summary
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | succeeded | failed | skipped | cancelled
  batch_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  input_reference TEXT,
  output_reference TEXT,
  error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS agent_steps_batch_idx ON agent_steps (run_id, batch_id);
CREATE INDEX IF NOT EXISTS agent_steps_status_idx ON agent_steps (run_id, status);

CREATE TABLE IF NOT EXISTS agent_messages (
  message_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  step_id TEXT,
  role TEXT NOT NULL, -- user | agent | system
  message_type TEXT NOT NULL, -- user_request | progress | status | file_changed | final_summary | error
  content TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS agent_messages_type_idx ON agent_messages (run_id, message_type);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  tool_call_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  step_id TEXT,
  batch_id TEXT,
  tool_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- running | succeeded | failed | cancelled
  input_reference TEXT,
  output_reference TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  duration_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS agent_tool_calls_run_idx ON agent_tool_calls (run_id, started_at);
CREATE INDEX IF NOT EXISTS agent_tool_calls_step_idx ON agent_tool_calls (step_id);
CREATE INDEX IF NOT EXISTS agent_tool_calls_tool_idx ON agent_tool_calls (tool_name, status);

CREATE TABLE IF NOT EXISTS agent_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  step_id TEXT,
  checkpoint_type TEXT NOT NULL, -- stage | batch | pre_change | recovery
  state_json TEXT NOT NULL DEFAULT '{}',
  completed_actions_json TEXT NOT NULL DEFAULT '[]',
  pending_actions_json TEXT NOT NULL DEFAULT '[]',
  next_action TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS agent_checkpoints_run_idx ON agent_checkpoints (run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE CASCADE,
  step_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_type TEXT NOT NULL DEFAULT 'final_summary',
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  estimated_cost REAL,
  status TEXT NOT NULL, -- succeeded | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS agent_usage_run_idx ON agent_usage (run_id, request_type);
CREATE INDEX IF NOT EXISTS agent_usage_created_idx ON agent_usage (created_at);
