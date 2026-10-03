-- "sandbox" D1: the authoritative project codebase (virtual filesystem + revisions). App data stays in the main D1.
CREATE TABLE IF NOT EXISTS sb_projects (
  project_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  current_revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sb_projects_owner_idx ON sb_projects (owner_id);

-- Files and folders. Path is normalized POSIX relative to the project root; parent is its folder ('' = root).
CREATE TABLE IF NOT EXISTS sb_nodes (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  parent TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  node_type TEXT NOT NULL,           -- file | folder
  content TEXT,
  encoding TEXT NOT NULL DEFAULT 'utf8',
  mime_type TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, path)
);
CREATE INDEX IF NOT EXISTS sb_nodes_parent_idx ON sb_nodes (project_id, parent);

-- One row per changed path per revision; enough to diff, audit and roll back.
CREATE TABLE IF NOT EXISTS sb_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  node_type TEXT NOT NULL,
  op TEXT NOT NULL,                  -- create | update | delete
  before_content TEXT,
  after_content TEXT,
  encoding TEXT NOT NULL DEFAULT 'utf8',
  task_id TEXT,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sb_revisions_idx ON sb_revisions (project_id, revision);
