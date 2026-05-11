-- Replace Social Blade pipeline with yutura.net scraper.
-- channels.source_id holds the yutura internal ID (e.g. "51388"),
-- letting later polls reuse the YouTube channel ID without refetching
-- yutura's per-channel detail page on every 48h cycle.
ALTER TABLE channels ADD COLUMN source_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_source_id
  ON channels (source_id) WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS yutura_pulls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pulled_at      TEXT NOT NULL,
  status         TEXT NOT NULL,   -- 'success' | 'failed'
  channels_count INTEGER,
  error          TEXT
);

DROP TABLE IF EXISTS social_blade_pulls;
