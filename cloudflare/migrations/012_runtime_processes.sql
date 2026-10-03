-- Real command execution and tracked dev-server processes in the GitHub runtime.
ALTER TABLE runtime_jobs ADD COLUMN stdout TEXT;
ALTER TABLE runtime_jobs ADD COLUMN stderr TEXT;
ALTER TABLE runtime_jobs ADD COLUMN phase TEXT; -- dev: starting | ready | failed | stopping
ALTER TABLE runtime_jobs ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runtime_jobs ADD COLUMN heartbeat_at INTEGER;
ALTER TABLE runtime_jobs ADD COLUMN process_info TEXT; -- dev: {command, port, startupMs, httpStatus}
CREATE INDEX IF NOT EXISTS runtime_jobs_active_idx ON runtime_jobs (project_id, status, kind);
