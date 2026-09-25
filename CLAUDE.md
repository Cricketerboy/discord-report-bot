# CLAUDE.md: project context for AI assistants

Discord slash-command bot (HTTP interactions, no gateway) plus a login-protected dashboard.
Node 22 + TypeScript (ESM, `.js` import suffixes), Express 5, Postgres via `pg`, no ORM, no frontend build.

## Commands
- `npm run dev`: start with `.env` (tsx watch). `npm run db:local` gives a zero-install Postgres on :5433 (use `DATABASE_POOL_MAX=1`).
- `npm run typecheck`, `npm test` (unit), `npm run test:e2e` (spawns the real app against PGlite + mock Discord/Slack/Groq).
- Run typecheck and both test suites before calling a change done.

## Invariants: do not break these
1. **Signature first.** `/interactions` verifies Ed25519 over the *raw* body before parsing anything. Its router is mounted before every body parser in `src/app.ts`.
2. **3-second budget.** Everything before the HTTP response shares one `Deadline` (2.3 s). Slow work is deferred (type 5/6) and finished by a job that edits `@original`. Never `await` a network call to Discord, Slack or the LLM on the request path.
3. **Persist before acknowledging.** An interaction and the jobs it owes are written in ONE transaction (`ingest`). If the DB misses the budget, they go to the spool instead. Everything written there must stay idempotent (`ON CONFLICT DO NOTHING` on the interaction id and the job `dedupe_key`).
4. **One job per side effect.** Handlers in `src/jobs/handlers.ts` must be safe to run twice: check "already done" state, use Discord `nonce`, use conditional updates.
5. **Errors decide retries.** Throw `JobError(msg, retryable)`. `HttpError` classifies 408/425/429/5xx as retryable and other 4xx as permanent.
6. **No secrets in output.** Never log or store raw URLs of webhooks, interaction tokens or env secrets. Route error text through `errorMessage()`/`redact()`. Mirror webhooks are stored encrypted; decrypt only at send time (`getMirrorWebhook`, which registers the value with the scrubber).
7. **Multi-tenant isolation.** Every dashboard/API route is scoped by `guild_admins`. Every report query is scoped by `guild_id`.
8. **User text never pings.** Every Discord message sets `allowed_mentions`, and Slack text goes through `slackEscape`.
9. **Inside a transaction, use the transaction client** (`c.query`), never the pool. The e2e suite runs with a pool of 1 and will deadlock if you don't.

## Layout
- `src/interactions/`: route → handler (per interaction type) → ingest/spool
- `src/jobs/`: queue (claim with `FOR UPDATE SKIP LOCKED`, backoff, dead-letter), worker, handlers
- `src/services/`: rules engine (pure), triage (Groq + heuristic fallback), mirror, guild config cache, reports, events
- `src/web/`: auth (scrypt, hashed session ids, CSRF), OAuth connect, dashboard pages, JSON + SSE API
- Schema lives in `src/db/schema.ts`. Changes must be additive and idempotent (`IF NOT EXISTS`); it runs on every boot.

## Style
- Small modules, named exports, comments explain *why* rather than *what*.
- Views use the escaping `html` tagged template (`src/lib/html.ts`). Never build HTML by string concatenation.
- Dashboard JS (`public/app.js`) uses `textContent` only, with no inline scripts (strict CSP).
