-- Click tracking, smarter follow-ups, story triggers, any-post rules, rate limiting, uploads, analytics
ALTER TABLE rules ADD COLUMN triggers TEXT;            -- JSON: ["comment","dm","story_reply","story_mention"]
ALTER TABLE rules ADD COLUMN thing TEXT;               -- "workflow", "PDF"... used in message copy
ALTER TABLE rules ADD COLUMN review_text TEXT;         -- follow-up when they DID open the link

ALTER TABLE leads ADD COLUMN token TEXT;               -- click-tracking id
ALTER TABLE leads ADD COLUMN clicks INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN first_click INTEGER;
ALTER TABLE leads ADD COLUMN feedback TEXT;            -- answer to "how was it?"
ALTER TABLE leads ADD COLUMN media_id TEXT;            -- which post/story it came from
CREATE UNIQUE INDEX IF NOT EXISTS leads_token ON leads (token);

ALTER TABLE posts ADD COLUMN uploads TEXT;             -- JSON R2 keys to delete after publishing

CREATE TABLE IF NOT EXISTS sends (                     -- rate-limit ledger
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                                  -- dm | reply
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sends_window ON sends (ig_user_id, kind, ts);

CREATE TABLE IF NOT EXISTS outbox (                    -- queued sends when over the limit / rate limited
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                                  -- dm | reply
  payload TEXT NOT NULL,                               -- JSON
  label TEXT,
  attempts INTEGER DEFAULT 0,
  next_try INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (next_try);

CREATE TABLE IF NOT EXISTS post_stats (                -- latest insights snapshot per post
  media_id TEXT PRIMARY KEY,
  ig_user_id TEXT NOT NULL,
  permalink TEXT,
  caption TEXT,
  media_type TEXT,
  posted INTEGER,
  views INTEGER, reach INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER,
  updated INTEGER
);
