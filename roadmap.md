# Roadmap — Speed Agent internal tool system

- [x] Live agent runs every action through the ToolOrchestrator (policy, validation, audit)
- [x] Phase-limited tool exposure for the model
- [x] Git, dependency, environment, state/snapshot, planning, knowledge, logs, security, cleanup, recovery, integration, orchestration, transform, asset tools (138 total)
- [x] Real command runtime (install/build/typecheck/lint/test/format/script) on GitHub Actions, verified end to end
- [x] Missing database updates (tool operations, plans, command jobs) applied to production; deploy now applies them automatically
- [ ] Browser-based preview checks (screenshots, console errors) — needs Cloudflare Browser Rendering enabled on the account
- [ ] Database/API testing tools for user projects — waiting on how user projects should store data
- [ ] Redeploy the live-updates worker — waiting on REALTIME_SECRET
- [ ] Old AI fallback tests use a test helper the backend test runner lacks — rewrite them
