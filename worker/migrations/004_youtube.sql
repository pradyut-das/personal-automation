-- YouTube: connected channels, keyword comment replies, scheduled uploads, stats
CREATE TABLE IF NOT EXISTS yt_accounts (
  channel_id     TEXT PRIMARY KEY,
  title          TEXT,
  handle         TEXT,
  uploads_playlist TEXT,
  refresh_token  TEXT NOT NULL,
  access_token   TEXT,
  access_expires INTEGER,
  status         TEXT DEFAULT 'active',        -- active | paused | token_error
  error          TEXT,
  last_poll      INTEGER,                       -- newest comment time we've processed
  created        INTEGER
);

CREATE TABLE IF NOT EXISTS yt_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  video_ids   TEXT NOT NULL,                    -- JSON array, "*" = every video
  title       TEXT,                             -- video title for display
  keywords    TEXT NOT NULL,                    -- JSON array, lowercase
  link_url    TEXT,
  replies     TEXT,                             -- JSON array of templates; {name} {link}; NULL = defaults
  mode        TEXT DEFAULT 'link',              -- link: put the link in the reply | description: point to the description
  active      INTEGER DEFAULT 1,
  created     INTEGER,
  UNIQUE (channel_id, name)
);

CREATE TABLE IF NOT EXISTS yt_replies (
  comment_id  TEXT PRIMARY KEY,                 -- the viewer's comment (thread id)
  channel_id  TEXT NOT NULL,
  rule_id     INTEGER,
  video_id    TEXT,
  author      TEXT,
  text        TEXT,
  reply_id    TEXT,
  status      TEXT,                             -- replied | failed | skipped_quota
  error       TEXT,
  created     INTEGER
);
CREATE INDEX IF NOT EXISTS yt_replies_created ON yt_replies (channel_id, created);

CREATE TABLE IF NOT EXISTS yt_videos (           -- scheduled uploads
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  tags         TEXT,                            -- JSON array
  media_key    TEXT NOT NULL,                   -- R2 key of the video
  thumb_key    TEXT,                            -- R2 key of the custom thumbnail
  publish_at   INTEGER NOT NULL,
  status       TEXT DEFAULT 'pending',          -- pending | uploading | scheduled | published | failed
  video_id     TEXT,
  privacy      TEXT,                            -- what YouTube reports
  autoreply    TEXT,                            -- JSON rule created once the video exists
  attempts     INTEGER DEFAULT 0,
  error        TEXT,
  created      INTEGER
);
CREATE INDEX IF NOT EXISTS yt_videos_due ON yt_videos (status, publish_at);

CREATE TABLE IF NOT EXISTS yt_stats (
  video_id   TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title      TEXT,
  published  INTEGER,
  is_short   INTEGER,
  views      INTEGER, likes INTEGER, comments INTEGER, minutes INTEGER,
  updated    INTEGER
);
