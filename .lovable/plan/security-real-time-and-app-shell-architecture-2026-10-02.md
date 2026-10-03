# Security, Real-time and App Shell architecture

Keeps the current UI. Adds three root modules and wires them into the existing Cloudflare D1 + custom-auth backend.

## What you get
- Signed-out visitors opening a protected page go straight to log-in; no protected screen or data loads first.
- After the first visit the app opens from the copy saved in the browser, then refreshes data in the background.
- Projects, project details/settings, tasks, tool state, chat messages, profile, library, imports and integrations update instantly in every open window, with no page reloads and no polling.
- Subscription checks are built and enforced on the server; payments stay off until you add Stripe (everyone gets the free plan meanwhile).

## Cost note
Live updates need a small relay service deployed to your Cloudflare account (a Worker with a Durable Object). Cloudflare's free plan includes a usage allowance; heavy use may be billed by Cloudflare per request and duration.

## Technical details

### security/ (TypeScript only, server-side)
- `session.ts` – wraps existing PBKDF2 + hashed-cookie session (create, validate, rotate, revoke).
- `authorize.ts` – `requireUser()` and ownership checks (`assertOwnsProject`, etc.) used by every server function.
- `entitlements.ts` – reads a new `subscriptions` table and returns authoritative entitlements; Stripe webhook route `/api/public/stripe/webhook` with signature verification, inactive until `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` exist.
- `validation.ts` – shared zod schemas; `realtime-token.ts` – short-lived HMAC tokens scoped to one user's channel.
- Existing `src/lib/auth/*` re-exports from here to avoid duplicates.

### real-time/
- `worker/` – Cloudflare Worker + Durable Object (`UserHub`, one per user) using WebSocket hibernation. Verifies the client token on connect; accepts publish calls only with a server-held secret. Deployed via the Cloudflare API with your saved token; URL stored as a secret.
- `events.ts` – typed delta events `{ entity, op: upsert|delete, id, version, data }` with monotonic per-row `version`.
- `publish.server.ts` – after each D1 write, server functions publish the delta.
- `client.ts` – connection manager: auto connect, exponential reconnect with jitter, resume from last seen sequence (DO keeps a short replay buffer; falls back to a single delta fetch since `last_seq`), dedupe by event id, drop stale versions, server wins on conflicts.
- `store.ts` – TanStack Query cache patching per entity so only affected UI re-renders.

### Data layer
- New server functions (CRUD) for projects, tasks, messages, profile, integrations, imports, tool state — each: validate → authorize → write D1 → bump version → publish.
- Pages switch from empty local state to these queries; UI markup unchanged.
- Schema additions: `version` + `updated_at` columns, `subscriptions`, `change_log` (for resume).

### shell/index.ts
- Boot order: session check → (unauth: auth page only) → register Service Worker → open IndexedDB → hydrate Query cache from IndexedDB → fetch deltas → connect real-time.
- Protected routes move under a `_authenticated` layout whose `beforeLoad` calls the cookie-based `getMe` server-side and redirects before any protected code or data loads; protected pages are lazy chunks.
- `public/sw.js`: precache hashed build assets (cache-first), network-first for HTML, never caches server functions or API responses; updates in background.
- IndexedDB (`idb-keyval`-style minimal wrapper) stores per-user query snapshots, cleared on sign-out.

### Verification
Playwright: new/existing sign-in, unauthorized and authorized protected URLs, second launch served from Service Worker, two browser contexts seeing each other's changes, forced socket drop + recovery, entitlement check, cross-user access rejected, no full reloads.

### AGENTS.md
Record the three-layer rules and the real-time publish-after-write rule.
