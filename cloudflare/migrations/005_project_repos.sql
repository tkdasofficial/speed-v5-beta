-- One GitHub repository per Speed project (owner's GitHub connection is the account reference).
CREATE TABLE IF NOT EXISTS project_repos (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES github_connections(user_id) ON DELETE CASCADE,
  github_repo_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 1,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
