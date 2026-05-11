-- channels: Social Blade에서 수집한 YouTube 채널 마스터
CREATE TABLE IF NOT EXISTS channels (
  id              TEXT PRIMARY KEY,
  handle          TEXT,
  name            TEXT NOT NULL,
  thumbnail_url   TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,  -- 1=active, 0=inactive (이탈)
  first_seen_at   TEXT NOT NULL,               -- ISO 8601 UTC
  last_seen_at    TEXT NOT NULL                -- ISO 8601 UTC
);

-- subscriber_snapshots: YouTube API 6h 폴링 시점별 구독자 수 스냅샷
CREATE TABLE IF NOT EXISTS subscriber_snapshots (
  channel_id        TEXT NOT NULL REFERENCES channels(id),
  polled_at         TEXT NOT NULL,
  subscriber_count  INTEGER NOT NULL,
  video_count       INTEGER,
  view_count        INTEGER,
  PRIMARY KEY (channel_id, polled_at)
);

CREATE INDEX IF NOT EXISTS idx_subscriber_snapshots_channel_id_polled_at
  ON subscriber_snapshots (channel_id, polled_at);

-- social_blade_pulls: Social Blade 폴링 이력 (실패 추적용)
CREATE TABLE IF NOT EXISTS social_blade_pulls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pulled_at      TEXT NOT NULL,
  status         TEXT NOT NULL,   -- 'success' | 'failed'
  channels_count INTEGER,
  error          TEXT
);

-- youtube_polls: YouTube 구독자 폴링 이력 (실패/쿼터 초과 추적용)
CREATE TABLE IF NOT EXISTS youtube_polls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  polled_at      TEXT NOT NULL,
  status         TEXT NOT NULL,   -- 'success' | 'failed' | 'quota_exceeded'
  channels_count INTEGER,
  error          TEXT
);

-- client_channel_snapshots: 클라이언트 채널 라이브/좋아요 스냅샷
CREATE TABLE IF NOT EXISTS client_channel_snapshots (
  polled_at      TEXT NOT NULL PRIMARY KEY,
  live_viewers   INTEGER,         -- NULL = 라이브 없음
  like_count     INTEGER,
  live_video_id  TEXT
);
