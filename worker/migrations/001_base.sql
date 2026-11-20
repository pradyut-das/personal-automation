CREATE TABLE IF NOT EXISTS accounts (
  ig_user_id      TEXT PRIMARY KEY,          -- 1784... professional account id (webhook entry.id)
  app_scoped_id   TEXT,                      -- /me id
  username        TEXT NOT NULL,
  token           TEXT NOT NULL,
  token_expires   INTEGER,
  token_refreshed INTEGER,
  last_reply_idx  INTEGER DEFAULT -1,        -- so the same public reply isn't used twice in a row
  status          TEXT DEFAULT 'active',     -- active | paused | token_error
  error           TEXT,
  created         INTEGER
);

CREATE TABLE IF NOT EXISTS rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  media_ids      TEXT NOT NULL,              -- JSON array
  permalink      TEXT,
  keywords       TEXT NOT NULL,              -- JSON array, lowercase
  require_follow INTEGER DEFAULT 0,
  opener_text    TEXT NOT NULL,              -- first DM (private reply to the comment)
  ask_button     TEXT NOT NULL,              -- "Send me the workflow"
  link_text      TEXT NOT NULL,              -- DM that carries the link
  link_title     TEXT NOT NULL,              -- link button label
  link_url       TEXT NOT NULL,
  followup_text  TEXT,                       -- NULL = no follow-up
  followup_mins  INTEGER DEFAULT 60,
  public_replies TEXT,                       -- JSON array; NULL = the 25 generic replies
  dm_trigger     INTEGER DEFAULT 1,          -- DMing the keyword also starts the flow
  active         INTEGER DEFAULT 1,
  created        INTEGER,
  UNIQUE (ig_user_id, name)
);

CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id   TEXT NOT NULL,
  rule_id      INTEGER NOT NULL,
  igsid        TEXT NOT NULL,
  username     TEXT,
  comment_id   TEXT,
  comment_text TEXT,
  source       TEXT,                         -- comment | dm
  stage        TEXT NOT NULL,                -- new | opened | asked_follow | link_sent | followed_up | error
  followup_due INTEGER,
  created      INTEGER,
  updated      INTEGER,
  UNIQUE (rule_id, igsid)                    -- one flow per person per automation
);
CREATE INDEX IF NOT EXISTS leads_due   ON leads (stage, followup_due);
CREATE INDEX IF NOT EXISTS leads_igsid ON leads (ig_user_id, igsid);

CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY,
  ig_user_id   TEXT NOT NULL,
  publish_at   INTEGER NOT NULL,
  type         TEXT NOT NULL,                -- image | reel | carousel | story
  media        TEXT NOT NULL,                -- JSON array of public URLs
  caption      TEXT,
  cover        TEXT,
  status       TEXT DEFAULT 'pending',       -- pending | processing | published | failed
  children     TEXT,                         -- JSON array of carousel child container ids
  container_id TEXT,
  started      INTEGER,
  attempts     INTEGER DEFAULT 0,
  error        TEXT,
  media_id     TEXT,
  permalink    TEXT,
  autodm       TEXT,                         -- JSON rule (minus media) created when it publishes
  created      INTEGER
);
CREATE INDEX IF NOT EXISTS posts_due ON posts (status, publish_at);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id TEXT,
  ts         INTEGER,
  level      TEXT,                           -- info | warn | error
  msg        TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
