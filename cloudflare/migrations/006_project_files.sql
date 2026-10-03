-- Imported project files reuse the existing `files` table, plus columns describing each file.
ALTER TABLE files ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';  -- text | binary (base64 content) | too_large (metadata only)
ALTER TABLE files ADD COLUMN source TEXT;                          -- github | gitlab | bitbucket | zip | directory
CREATE INDEX IF NOT EXISTS files_project_idx ON files (project_id, path);
