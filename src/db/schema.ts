/**
 * Idempotent schema. Applied at boot (under an advisory lock, so overlapping deploys don't race)
 * and via `npm run db:migrate`. New changes should be appended as additive, IF NOT EXISTS statements.
 */
export const schemaSql = /* sql */ `
CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash        TEXT PRIMARY KEY,
  admin_id       INT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token     TEXT NOT NULL,
  oauth_state    TEXT,
  oauth_state_at TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guilds (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  icon                TEXT,
  report_channel_id   TEXT,
  report_channel_name TEXT,
  alert_role_id       TEXT,
  mirror_webhook_enc  TEXT,
  mirror_kind         TEXT,
  mirror_hint         TEXT,
  settings            JSONB NOT NULL DEFAULT '{}'::jsonb,
  commands_synced_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_admins (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  admin_id INT  NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, admin_id)
);

CREATE TABLE IF NOT EXISTS rules (
  id              SERIAL PRIMARY KEY,
  guild_id        TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  position        INT NOT NULL DEFAULT 0,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  condition_type  TEXT NOT NULL,
  condition_value TEXT NOT NULL DEFAULT '',
  action_type     TEXT NOT NULL,
  action_value    TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rules_guild_idx ON rules (guild_id, position);

-- One row per Discord interaction id: the primary key IS the dedup guarantee.
CREATE TABLE IF NOT EXISTS interactions (
  id            TEXT PRIMARY KEY,
  token         TEXT NOT NULL,
  type          SMALLINT NOT NULL,
  guild_id      TEXT,
  channel_id    TEXT,
  user_id       TEXT,
  user_name     TEXT,
  command       TEXT,
  input         TEXT,
  outcome       TEXT NOT NULL DEFAULT 'received',
  response_type SMALLINT,
  response_ms   INT,
  spooled       BOOLEAN NOT NULL DEFAULT false,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS interactions_guild_idx ON interactions (guild_id, received_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id                 SERIAL PRIMARY KEY,
  guild_id           TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  interaction_id     TEXT NOT NULL UNIQUE,
  channel_id         TEXT,
  user_id            TEXT,
  user_name          TEXT,
  text               TEXT NOT NULL,
  source             TEXT NOT NULL,
  severity           TEXT NOT NULL DEFAULT 'low',
  category           TEXT NOT NULL DEFAULT 'other',
  summary            TEXT,
  tags               TEXT[] NOT NULL DEFAULT '{}',
  ai_status          TEXT NOT NULL DEFAULT 'pending',
  ai_model           TEXT,
  matched_rules      JSONB NOT NULL DEFAULT '[]'::jsonb,
  mentions           TEXT[] NOT NULL DEFAULT '{}',
  notes              TEXT[] NOT NULL DEFAULT '{}',
  mirror             BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL DEFAULT 'open',
  status_by          TEXT,
  status_at          TIMESTAMPTZ,
  channel_message_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_guild_idx ON reports (guild_id, created_at DESC);

-- Durable outbox / work queue. dedupe_key makes enqueueing idempotent.
CREATE TABLE IF NOT EXISTS jobs (
  id             BIGSERIAL PRIMARY KEY,
  kind           TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL UNIQUE,
  guild_id       TEXT,
  interaction_id TEXT,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'pending',
  attempts       INT NOT NULL DEFAULT 0,
  max_attempts   INT NOT NULL DEFAULT 8,
  run_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at      TIMESTAMPTZ,
  locked_by      TEXT,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (run_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS jobs_interaction_idx ON jobs (interaction_id);
CREATE INDEX IF NOT EXISTS jobs_guild_status_idx ON jobs (guild_id, status);

CREATE TABLE IF NOT EXISTS events (
  id             BIGSERIAL PRIMARY KEY,
  guild_id       TEXT,
  interaction_id TEXT,
  level          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  message        TEXT NOT NULL,
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_guild_idx ON events (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_interaction_idx ON events (interaction_id);
`;
