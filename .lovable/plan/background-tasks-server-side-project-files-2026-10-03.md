# Background tasks + server-side project files

Combines both briefs. After this, project files live on the server, and every AI request runs as a server task that keeps going if you close the tab, lose signal, or sign out.

## What you get
- Ask the AI something, close the app, come back later: the work is finished (or still running), with every step shown in chat.
- Project files are saved to your account, not this browser, so every device sees the same files.
- Each file keeps its history; two edits at once can't silently overwrite each other; Rollback still works.
- Stop really stops the task on the server. Failed steps retry a few times on their own.
- A small "running tasks" list shows what is working right now, across the app.
- Existing files you already made in this browser are uploaded once, automatically, the first time you open each project.

## What stays the same
- The look of the app, chat, Files/Code window, Preview, Model Selector, integrations.
- Preview keeps showing static sites, now from the server files (no new build tool, per the brief).

## What is not included (per the brief)
- Terminal, npm, builds, Docker, deployment, GitHub runtime. Large images/videos go to file storage only when R2 is set up.

## Cost note
Running work after the tab closes uses a Cloudflare Durable Object (same kind already used for live updates). Free plan allowance applies; heavy use may be billed by Cloudflare.

## Technical details

### Databases
- New D1 database `sandbox` (created via Cloudflare API, bound as `SANDBOX_DB`); existing D1 untouched except a new `tasks` + `task_events` pair.
- `cloudflare/migrations-sandbox/001.sql`: `sb_projects(id, owner_id, current_revision)`, `sb_nodes(id, project_id, parent_id, path UNIQUE per project, name, node_type, content, mime, size, r2_key, version, deleted_at)`, `sb_revisions(id, project_id, revision, node_path, op, before, after, task_id, created_at)`.
- Main D1 `009_tasks.sql`: `tasks(id, user_id, project_id, type, status queued|running|retrying|completed|failed|cancelled, payload, progress, current_step, result, error, retry_count, max_retries, worker_id, heartbeat, idempotency_key UNIQUE(user_id,key), timestamps)`, `task_events(task_id, seq, kind, data, created_at)`.

### Server sandbox (`cloudflare/sandbox/`)
- `fs.server.ts`: normalized/guarded paths, create/read/write/patch/delete/rename/move for files and folders, tree build, optimistic `expectedVersion` checks, one revision row per change, rollback to revision.
- `tools.server.ts`: ports the existing intelligence tools (search, read ranges, edit, validate) onto the server store; HTML/CSS/JS validation reused from `sandbox/intelligence` (pure code, runs in the Worker). No build/execution.

### Task system (`cloudflare/tasks/`)
- `registry.ts`: `registerTaskType(type, handler)`; handlers get `{ task, step(), progress(), emit(), signal }`. Initial types: `ai_agent`, `file_operation`; future features just register.
- `TaskRunner` Durable Object: claims a task (lease + heartbeat), runs it step by step using alarms (one agent round per alarm, so long jobs never hit request time limits), persists events, publishes live updates through the existing real-time hub. Retries with backoff on 429/5xx/timeouts; recovery alarm re-claims tasks with stale heartbeats; cancel flag checked between steps.
- API in `api/tasks.ts`: create (idempotent), get, list active/recent, events since seq, cancel. Ownership checked on every call.

### Agent
- Agent loop moves from `src/lib/agent` into the `ai_agent` handler; it calls `runAgentRound` + server tools directly. Snapshot/checkpoint becomes a revision marker.

### Frontend
- `src/lib/tasks`: task store (cache only), rebuilt from the API on load and kept live by real-time events.
- WorkspaceStore reads/writes files through the API instead of localStorage; one-time upload of existing local files; local copy then cleared.
- Chat timeline reads task events; Stop calls cancel.
- No `.local`/`.output` folders on the new path.

### Verification
Unit tests for fs + revisions + conflicts; real run: start an AI task, close the browser, reopen, see it completed; cancel; retry on forced failure.
