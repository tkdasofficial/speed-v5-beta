# Speed Agent internal tool system: what's missing and how to build it

## What already exists

- **The tool system's core is solid.** It has a tool list, a central controller, permission rules, required-step checks, guards that stop repeated failures, results in one standard format, and a log of every run in the database. 49 of the spec's ~200 tools are built: files, project discovery, code analysis, snapshots, project state, operation logs and failure diagnosis.
- **The problem:** the live chat agent doesn't use this system. It runs its own simpler set of about 15–20 tools, which has no permission rules, no operation IDs and no run log. So the spec's core rules (one controller, every run logged, policy checks, project scope) don't apply to what users actually see.
- **Missing entirely:** Git, deployment, dependencies, settings and keys, integrations, assets, database, API testing, cleanup, security checks, the planning tools, and most of the commands, preview, recovery and logs tools.

## Plan (four phases, each tested before the next)

### Phase 1: Make the live agent use the tool system
- Point the chat agent at the central tool system and remove its separate tool set.
- Every step gets an operation ID, a permission check, input validation, a run log entry and a standard result.
- Show the model only the tools for the current phase (planning, building, checking), as the spec requires.
- Test: a real agent run edits files, and each step appears in the run log with before/after versions.

### Phase 2: Tools that can run directly in Cloudflare
- **Git:** status, diff, commit, branches, push, pull and history, using GitHub with the user's saved GitHub sign-in.
- **Dependencies:** add, remove, update and list packages in the project's package file, using real data from the npm registry.
- **Settings:** read, set, delete and list a project's settings and keys, stored encrypted.
- **Snapshots:** add delete and compare.
- **State and history:** project details, change history, last build.
- **Planning:** create a plan, update its steps, mark them done, read progress (saved with the task).
- **Agent memory:** record decisions, recall earlier actions.
- **Logs:** search logs, plus error, build and activity logs.
- **Security:** scan for leaked keys, check config files, block unsafe paths.
- **Code changes:** apply a change set, format a file, create a component or page from a template.
- **Cleanup and recovery:** remove temporary files; retry, roll back, restore an earlier version, recover the project.
- **Assets:** upload, list, delete and optimise project images and files (stored in Google Drive).
- **Integrations:** list, check and test connected accounts, using the existing connection system.
- **Control tools:** wait for an operation, retry a failed one, roll back, finish and verify.

### Phase 3: Commands and builds (on the existing speed-runtime GitHub build)
- Cloudflare can't run a terminal, so commands, tests, lint, type checks, package installs and builds run as GitHub Actions jobs in `tkdasofficial/speed-runtime`. Results stream back as task events.
- Real type-check and lint results replace the current pattern-based checks.
- Deployment: prepare, check the output, upload, deploy, check status and roll back, using the existing Drive build-file storage and preview links.

### Phase 4: Preview and browser checks
- Use Cloudflare's built-in browser to open the preview, check that pages load, collect console errors and run a quick test.
- Preview tools: start, stop, restart, get the link and status.

### Out of scope until you decide
- Database and API-testing tools need a separate database for each project, which the app doesn't have yet. I'll stub nothing; they stay missing until you choose a database approach.

## Testing
Each phase ends with real calls against the live backend: the tool runs, a log entry is written, and the result reads back. For Phase 1, a full agent task runs from start to finish.

## Technical details
- Tool catalog modules go in `cloudflare/tools/catalog/<category>.ts`, registered through `defineTool`, and run through `ToolSession` in `agent.server.ts`.
- New tables (`project_plans`, `project_assets`, `operation_logs` index) go in migration `011`.
- The runtime job is called through `build/pipeline.server.ts`, with a new `command` job type in the speed-runtime workflow.
- Browser checks use the Cloudflare Browser Rendering binding, added in `deploy.ts`. The API token needs the Browser Rendering permission.
- After each phase: redeploy with `bun cloudflare/functions/deploy.ts`, then run end-to-end checks with curl against the worker.
