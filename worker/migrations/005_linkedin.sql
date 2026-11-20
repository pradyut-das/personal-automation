-- LinkedIn personal profile: connected member + scheduled posts
CREATE TABLE IF NOT EXISTS li_accounts (
  person_urn   TEXT PRIMARY KEY,        -- urn:li:person:xxxx
  name         TEXT,
  email        TEXT,
  access_token TEXT NOT NULL,
  expires      INTEGER,                 -- self-serve LinkedIn apps get 60-day tokens, no refresh
  status       TEXT DEFAULT 'active',   -- active | expired
  error        TEXT,
  created      INTEGER
);

CREATE TABLE IF NOT EXISTS li_posts (
  id          TEXT PRIMARY KEY,
  person_urn  TEXT NOT NULL,
  publish_at  INTEGER NOT NULL,
  text        TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- text | image | images | video | document
  media       TEXT,                     -- JSON [{key, size, type, title}]
  assets      TEXT,                     -- JSON LinkedIn asset urns once uploaded
  status      TEXT DEFAULT 'pending',   -- pending | uploading | processing | published | failed
  post_urn    TEXT,
  permalink   TEXT,
  attempts    INTEGER DEFAULT 0,
  started     INTEGER,
  error       TEXT,
  created     INTEGER
);
CREATE INDEX IF NOT EXISTS li_posts_due ON li_posts (status, publish_at);
