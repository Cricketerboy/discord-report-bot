# Discord Report Bot

A Discord slash-command bot plus a web dashboard. Users file reports with `/report` or check health with `/status`. The bot:

1. verifies each request,
2. records it,
3. triages it with an LLM,
4. applies admin-configured rules,
5. replies in Discord,
6. posts a moderator card with buttons, and
7. mirrors a notification to Slack or a second Discord channel.

Admins sign in to a dashboard to connect servers, configure behaviour, and watch a live log of every command and action, including failures and retries.

It uses Discord **HTTP interactions** (no gateway websocket). All work after the first acknowledgement runs through a durable Postgres-backed job queue.

## For reviewers: how to test

| | |
|---|---|
| **Live app** | <https://discord-report-bot-iarh.onrender.com> (free Render instance, kept awake by a self-ping. If it was asleep, the first page load can take about 30 s) |
| **Dashboard login** | Throwaway admin credentials are in the submission email (kept out of this public repo) |
| **Test server invite** | <https://discord.gg/yWyk7REDTk> |
| **Mirror channel** | `#mod-alerts` in the test server (a Discord channel webhook). Reports are carded in `#reports` |

**Happy path (about 2 minutes)**

1. Join the test server. Open the dashboard in another tab, sign in, click the server, and stay on **Live log**.
2. In `#general`, run `/report text: the checkout page is down for everyone`.
   - You get an ephemeral "thinkingâ€¦" that turns into a *Report #N received* reply with the AI summary, severity and category.
   - A report card appears in the report channel. The "down" keyword rule escalates it to **critical**, which mentions the alert role.
   - A mirror notification arrives in the mirror channel.
   - In the dashboard, the row appears live, and each action (triage, reply, channel post, mirror) turns green as it completes.
3. Run `/report` **with no text** to get a modal form. Submit it and it goes through the same pipeline.
4. Click **Acknowledge** and then **Resolve** on the card. The message updates in place and each status change is mirrored. *Resolve* requires Manage Messages; if you lack it you get a polite refusal.
5. Run `/status` to get live counts and delivery health.

**Unhappy paths**

- **Forged / unsigned / replayed requests:** run `npm run probe -- <live-url>`, or send your own junk to `<live-url>/interactions`. Everything gets a `401`, and rejections are counted on the dashboard home under *Rejected requests*.
- **Downstream outage:** go to Settings â†’ *Fault injection* â†’ "Fail the next N mirror deliveries" = 3, then file a report. The Live log shows the mirror action retrying `â†» mirror (1/10)`, `(2/10)` â€¦ and then succeeding. Failures that exhaust retries or are permanent (for example, a deleted webhook) show up under **Failures** with a *Retry now* button.
- **AI down:** give a bad `GROQ_API_KEY`. Triage falls back to keyword rules, the reply still goes out, and an `ai.fallback` warning is logged.
- **Duplicates and the database being down:** Discord can't be made to redeliver on demand, so these are covered by the e2e suite (`npm run test:e2e`). It replays signed interactions, including after a process restart, and takes the database away mid-request.

## Features vs. the brief

| Requirement | Where |
|---|---|
| Public web app + interactions endpoint | `POST /interactions` ([src/interactions/route.ts](src/interactions/route.ts)) |
| Two or more slash commands | `/report [text]`, `/status`, registered per guild on connect ([src/discord/commands.ts](src/discord/commands.ts)) |
| Records every command | `interactions` table (one row per interaction id) plus the `events` audit trail |
| Responds in Discord | Deferred reply edited with the result; report card posted to the configured channel |
| Mirrors to a second channel | Slack Incoming Webhook **or** Discord channel webhook, per server ([src/services/mirror.ts](src/services/mirror.ts)) |
| Dashboard behind login | Live log (SSE), reports, rules, settings, failures ([src/web](src/web)) |
| **Stretch:** configurable rules | Rule engine: *keyword / severity â‰¥ / category / always* â†’ *set severity / mention role / mirror / don't mirror / add note* ([src/services/rules.ts](src/services/rules.ts)) |
| **Stretch:** buttons | Acknowledge / Resolve / Reopen, with a permission check, idempotent state changes, and in-place message updates |
| **Stretch:** modal | `/report` with no text opens a form, handled as `MODAL_SUBMIT` |
| **Stretch:** AI step | Groq (free tier, JSON mode, validated output) for summary, category, severity and tags. Falls back to keyword triage |
| **Stretch:** multi-server | Every server has its own channel, mirror, rules and log. Admins only see servers they connected through OAuth |
| **Stretch:** observability | Structured JSON logs (pino, secret-scrubbed), per-interaction timeline, retry/failure history, rejected-request counters |

## Architecture

```
Discord â”€â”€POST /interactionsâ”€â”€â–¶ verify Ed25519 + timestamp window â”€â”€âœ—â”€â”€â–¶ 401 (counted, never processed)
                                   â”‚
                                   â–¼
                      in-memory dedup (interaction id)
                                   â”‚
                  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”   budget: 2.3 s total
                  â–¼                                  â–¼
   INSERT interaction + jobs in ONE tx      DB slow/down (>1.2 s)?
   (PK on interaction id = dedup)           â†’ write to local spool (disk), still answer Discord
                  â”‚                                  â”‚  spool replays into DB when it's back
                  â–¼                                  â–¼
        answer Discord: defer (5) / message (4) / update (7) / modal (9)
                                   â”‚
                                   â–¼
              Postgres job queue (FOR UPDATE SKIP LOCKED, dedupe_key UNIQUE)
     report.process â”€â–¶ AI triage â”€â–¶ rules â”€â–¶ fan-out:
         discord.reply (edit @original) Â· discord.post_report (nonce-idempotent) Â· mirror.send
     each job: retry with exponential backoff + jitter (honours 429 retry_after) â†’ dead-letter + dashboard
```

### How each quality-bar item is handled

| Quality bar | Mechanism | Tested in |
|---|---|---|
| Forged / unsigned requests | Ed25519 check over `timestamp + raw body` using Node's built-in crypto, before any parsing. `401` on failure. The raw body is captured before any JSON parser runs. | `test/unit/verify.test.ts`, e2e |
| Replayed requests | The signed timestamp must be within Â±5 min. Inside that window, the interaction-id dedup catches replays. | unit + e2e |
| Same interaction delivered twice | (1) In-memory seen-set, which works even while the DB is down. (2) Primary key on `interactions.id`, written in the same transaction as the jobs it creates. (3) Every job has a unique `dedupe_key`. (4) Channel posts use Discord's `nonce` + `enforce_nonce`. (5) Button state changes are conditional updates (`WHERE status <> target`), so a repeated click changes nothing and notifies no one. | e2e: duplicate, and duplicate **after restart** |
| Downstream briefly unavailable | Each downstream call is its own job, retried with backoff (2 s â†’ 5 min cap, jitter, `Retry-After` respected). A mirror outage doesn't block the Discord reply. Permanent 4xx errors dead-letter immediately and are visible and retryable in the dashboard. | e2e: mirror 503 Ã—2 â†’ success on attempt 3 |
| AI unavailable | Two quick attempts, then deterministic keyword triage. The reporter is never left waiting on the LLM. | e2e |
| Own service / DB briefly unavailable | If the DB can't answer in time, the interaction and the jobs it owes go to an on-disk spool and Discord still gets its answer on time. The spool drains into Postgres when the DB returns. Jobs stuck in `running` after a crash are recovered. The HTTP server starts before the DB is ready, so PING and verification keep working. | e2e: DB taken down mid-request |
| 3-second window | A shared `Deadline` (2.3 s) caps the config lookup, ingest and inline work. Anything slow is deferred (`type 5` / `type 6`) and finished by a job that edits `@original`. Tokens expire after 15 min, so jobs stop retrying a follow-up after that. | e2e asserts < 2.5 s |
| Secrets never exposed | Env only (validated at boot; the error lists names, never values). Mirror URLs are AES-256-GCM encrypted at rest, and the dashboard shows only a hint. Logs, stored errors and events pass through a scrubber (known secret values plus webhook, token and DSN patterns). Interaction tokens never leave the server. `allowed_mentions: {parse: []}` everywhere, and Slack text is escaped, so user text can't `@everyone`. | e2e scans all app logs for secrets |

Other hardening:

- Dashboard: scrypt passwords, `__Host-` httpOnly session cookies (session ids stored hashed), CSRF tokens plus an Origin check on every POST, login rate limit, strict CSP (no inline scripts), and per-guild authorization on every route.
- OAuth: `state` is single-use and expires in 10 min.
- Mirror URLs are restricted to real Slack/Discord webhook hosts (SSRF guard).

### Key design decisions

- **HTTP interactions and a DB-backed queue instead of a gateway bot plus Redis.** Only one free service is needed (Postgres). Jobs survive restarts, and the queue state *is* the dashboard's action log.
- **Persist before acknowledging.** An interaction is acknowledged only after it has been durably recorded, in Postgres or the spool, together with the work it owes. That is what makes "never silently lose it" and "never do it twice" hold at the same time.
- **One job per side effect.** A failing mirror retries on its own without re-running AI triage or re-posting to Discord.
- **Rejected requests are counted in memory, not written to the DB.** Junk traffic can't turn into database writes.

## Tech stack

Node 22 + TypeScript, Express 5, PostgreSQL (`pg`), zod, pino, helmet. The dashboard is server-rendered, with vanilla JS for the live log (Server-Sent Events). There's no frontend build step. Tests use `node:test`, with PGlite (real Postgres in WASM) for the end-to-end suite, so no Docker is needed.

## Run locally

**Prerequisites:** Node 20.11+ (22 recommended), plus a Discord application (see [docs/SETUP.md](docs/SETUP.md), step 2).

```bash
npm install
cp .env.example .env          # then fill in the Discord values
```

**Database:** pick one.

- **Zero install:** in a separate terminal run `npm run db:local` (Postgres via PGlite on port 5433, data in `.data/`). Wait for the *listening* line. Keep `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres` and `DATABASE_POOL_MAX=1`.
- **Neon:** paste your Neon connection string into `DATABASE_URL` and set `DATABASE_POOL_MAX=5`.

```bash
npm run dev                   # http://localhost:3000, migrates automatically
```

Sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

**Letting Discord reach your laptop:** Discord can't call `localhost`. A free, account-less tunnel works:

```bash
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
```

Then:

1. Set `PUBLIC_BASE_URL` to that URL and restart.
2. Set the portal's *Interactions Endpoint URL* to `<url>/interactions`.
3. Add `<url>/connect/discord/callback` under *OAuth2 â†’ Redirects*.

Using a separate Discord application for local development keeps production untouched.

### Tests

```bash
npm test            # unit: signature verification, rules engine, redaction, SSRF guard, crypto, parsing
npm run test:e2e    # spawns the real app against PGlite + mock Discord/Slack/Groq and runs the full flow
npm run typecheck
```

The e2e suite covers:

- **Security:** login, CSRF, OAuth connect (including a forged `state`), 401 on unsigned/forged/stale requests.
- **The main flow:** PING, `/report` â†’ AI â†’ rules â†’ reply â†’ channel post â†’ mirror, the modal flow, cooldown, buttons with permission checks, and `/status`.
- **Failure handling:** duplicate delivery, mirror retry, AI fallback, database outage â†’ spool â†’ replay, and dedup across a restart.
- **The dashboard:** every page renders.
- **Secrets:** the app's logs never contain them.

On Windows, PGlite prints "The system cannot find the path specified." a few times at startup. That message is harmless.

## Environment variables

| Name | Required | Description |
|---|---|---|
| `DATABASE_URL` | âœ“ | Postgres connection string (Neon/Supabase). `sslmode=require` â†’ TLS with verification; `sslmode=no-verify` â†’ TLS without verification |
| `DATABASE_POOL_MAX` | | Default 5 (use 1 with the local PGlite server) |
| `APP_SECRET` | âœ“ | 32+ random chars; derives the at-rest encryption key |
| `DISCORD_APPLICATION_ID` | âœ“ | Portal â†’ General Information |
| `DISCORD_PUBLIC_KEY` | âœ“ | Portal â†’ General Information (used for Ed25519 verification) |
| `DISCORD_BOT_TOKEN` | âœ“ | Portal â†’ Bot â†’ Reset Token |
| `DISCORD_CLIENT_SECRET` | âœ“ | Portal â†’ OAuth2 (for the "connect server" code exchange) |
| `PUBLIC_BASE_URL` | on non-Render hosts | Public https origin. On Render, `RENDER_EXTERNAL_URL` is used automatically |
| `GROQ_API_KEY` / `GROQ_MODEL` | | Enables AI triage (default model `openai/gpt-oss-20b`) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | | Seeds or updates an admin on every boot |
| `ALLOW_SIGNUP` | | `true` enables `/signup` (default `false`) |
| `KEEPALIVE` | | Self-ping to keep a free instance awake (default `true`) |
| `LOG_LEVEL`, `PORT`, `NODE_ENV` | | Standard |

## Deployment

The live instance runs on **Render (free web service)** with **Neon (free Postgres)**, auto-deployed from `main`. [docs/SETUP.md](docs/SETUP.md) has the click-by-click guide for every service (Discord portal, Neon, Slack/Discord webhook, Groq, Render, uptime ping). In short:

1. Render â†’ *New Web Service* from this repo.
2. Set the build command to `npm ci --include=dev && npm run build` and the start command to `npm start`.
3. Set the health check path to `/health` and add the env vars above (`NODE_ENV=production`).
4. After the first deploy, set the Discord *Interactions Endpoint URL* to `https://<app>.onrender.com/interactions`. Discord verifies it with a signed PING plus a deliberately bad signature, and the app handles both.
5. Add `https://<app>.onrender.com/connect/discord/callback` as an OAuth2 redirect.
6. Sign in to the dashboard â†’ *Connect a Discord server*.

Free Render instances sleep after 15 idle minutes, and Discord doesn't retry an interaction that times out. The app pings its own public URL every 10 minutes, and an external uptime monitor can be added as a backup. The worker only touches the DB when there's work (or every 30 min when idle), so Neon can scale to zero and the free compute quota isn't used up.

## Project layout

```
src/
  server.ts, app.ts        boot, graceful shutdown, middleware order (raw body before parsers)
  interactions/            route (verify) â†’ handler (per type/command) â†’ ingest (dedup+persist) â†’ spool
  jobs/                    queue (claim/retry/dead-letter), worker, handlers (one per side effect)
  services/                rules engine, AI triage, mirror, reports, guild config cache, events
  discord/                 signature verification, REST client, command + message builders
  web/                     auth, OAuth connect, dashboard pages, JSON + SSE API, views
  db/                      pool, idempotent schema, migration
public/                    CSS + dashboard JS
test/unit, test/e2e        node:test suites (e2e uses PGlite + mock upstreams)
scripts/                   migrate, register-commands, probe (junk-request tester)
```

## Known limitations

- **Single instance.** The cooldown map, the SSE bus and the rejected-request counters are in memory. The job queue itself is multi-instance safe (`SKIP LOCKED`).
- **The spool lives on local disk.** On Render's ephemeral disk it covers DB blips and restarts, but not loss of the host.
- **Mirror delivery is at-least-once.** Slack and Discord webhooks have no idempotency key, so a request that times out *after* delivery would be retried. Discord channel posts are exactly-once thanks to `enforce_nonce`.
