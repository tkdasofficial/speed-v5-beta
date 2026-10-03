# Sandbox rules

- The `sandbox/` engine (core, workspace, filesystem, editor, terminal, dependencies, processes, bridge, storage, security, project, types, utils) is plain TypeScript with no UI; `sandbox/.local/` is the project root itself and `sandbox/.output/` holds build output; execution capabilities throw NotImplementedError until a later phase, so nothing pretends to run.
- Preview renders only the last successful /sandbox/.output generation; failed generations never replace it.
- The agent's internal tools live in `sandbox/intelligence/` (search, deps, validate, errors, changes, tools); every agent file action goes through `AgentTools` so edits are boundary-checked, tracked and syntax-validated, and builds are transactional (validate → stage → verify → swap .output).
- In the app, the browser Sandbox is only a cache/preview mirror of the server codebase (`src/lib/workspace/server-sync.ts`): it loads from and sends edits to the server, and device-only files are uploaded once then dropped.
