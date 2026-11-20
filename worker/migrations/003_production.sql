-- Durable webhook events, alerts, cron lock
CREATE TABLE IF NOT EXISTS webhook_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hash       TEXT NOT NULL,                 -- sha256 of the body: Meta re-deliveries are ignored
  received   INTEGER NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | failed | dead
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_try   INTEGER NOT NULL,
  error      TEXT,
  done_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_hash ON webhook_events (hash);
CREATE INDEX IF NOT EXISTS webhook_events_due ON webhook_events (status, next_try);

CREATE TABLE IF NOT EXISTS alerts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  level   TEXT NOT NULL,                    -- urgent | error | warn
  key     TEXT,                             -- same key within an hour = one alert
  subject TEXT NOT NULL,
  body    TEXT,
  sent    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS alerts_unsent ON alerts (sent, ts);

CREATE TABLE IF NOT EXISTS locks (
  name    TEXT PRIMARY KEY,
  until   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
