# AI_NOTES

> **TODO (author):** This is a draft. The sections marked ✍️ must be in your own words, from your own experience. Reviewers read this file closely. Delete this note when done.

## Tools and how the work was split

- **Claude Code** (model: Claude Opus 5.5) inside VS Code. The brief was pasted in as the starting prompt. [`CLAUDE.md`](CLAUDE.md) holds the project context and invariants used for later AI sessions.
- The AI produced the first full implementation in one session: architecture, code, unit and e2e tests, README and setup guide. It iterated against `tsc` and the test suites until they passed.
- ✍️ **Me:** account setup (Discord portal, Neon, Render, Groq, Slack/Discord webhook), deployment, testing on the live URL, reviewing the design, and *TODO: anything you changed or rejected*.

## Key decisions (✍️ confirm, and keep only what you can defend)

1. **HTTP interactions and a Postgres-backed job queue instead of a gateway bot plus Redis.** The free tier gives one small web service and one Postgres. Putting the queue in Postgres means jobs survive restarts and need no extra service. The same table is the "actions taken" log the dashboard shows, and retries and dead letters come for free.
2. **Persist before acknowledging, and use a disk spool when the DB is slow.** The interaction row and the jobs it owes are written in one transaction before Discord is answered. If Postgres can't answer within the time budget (for example a Neon cold start or an outage), the same data goes to a local spool and is replayed later. That is what lets "never lose it" and "never do it twice" hold at once: every write is idempotent on the interaction id or the job's dedupe key.
3. **One job per side effect, with error classification.** Reply, channel post and mirror are separate jobs. A Slack outage retries only the mirror, and never re-runs the LLM or re-posts to Discord. 5xx, 429 and network errors retry with backoff; other 4xx errors go straight to the dead-letter list with a *Retry now* button.
4. **Deterministic fallback for the LLM.** The reporter is waiting on a deferred reply, so the bot tries the model twice and then uses keyword triage rather than retrying for minutes.

## Hardest bug / wrong turn

✍️ *TODO: write this from your own experience, especially anything you hit while deploying (portal verification, OAuth redirect, cold starts, env vars). Say what the AI got wrong, how you noticed, and how you fixed it.*

These real wrong turns happened during the AI-assisted build, caught in self-review or by the tests. Use whichever are true for you:

- **The worker polled the database every second.** The first job-worker design ran a `claimNext()` query every second. That works, but on Neon's serverless Postgres it keeps the compute awake around the clock and uses up the free plan's compute hours. It was caught by thinking through how Neon scales to zero, not by any test. The fix was to make the worker event-driven: enqueueing in-process wakes it, a timer is set for the next scheduled retry (`msUntilNextJob`), and there is a 30-minute idle safety poll.
- **The migration lock could leak behind a connection pooler.** Migrations first used `pg_advisory_lock` / `pg_advisory_unlock` as separate statements. Behind Neon's pooled endpoint (PgBouncer in transaction mode) those two statements can run on *different* backend connections. The unlock then fails and the lock stays held, so every later boot would hang on migration. The fix was `pg_advisory_xact_lock` inside the migration transaction, which is released by COMMIT.
- **An e2e failure that only appeared on Windows.** The spool/restart tests passed, but the test file still failed with an unhandled `ECONNRESET`. The cause was the test harness, not the app: `pglite-socket` rejects an internal lock promise when a client socket dies (Windows kills child processes hard) and never handles it. It was fixed in the harness only, with a comment explaining why.

## What I'd do with more time

- Move in-memory state (cooldowns, SSE fan-out, rejected-request counters) to Postgres (`LISTEN/NOTIFY`) so the app can scale past one instance.
- Durable spool storage that survives host loss, for example a second free database or object storage.
- Per-guild rate limiting and abuse controls; an audit log of dashboard config changes, with who changed what.
- AI: few-shot examples per server, duplicate-report clustering, and letting the rules engine use AI tags.
- OpenTelemetry traces across interaction → jobs → upstream calls; alerting when dead letters appear.

## Prompt excerpt (optional)

> *(the whole assignment brief pasted in, followed by)* "i have this assignment so build this, i have open abstrabity folder, make this assignment, and bata dena run kaise karna hai, make sure har step cover ho kuch break na ho"
