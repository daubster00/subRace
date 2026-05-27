-- M1: subscriber_snapshots를 마일스톤 히스토리 테이블로 전환 + 신규 상태 테이블 도입.
--
-- 변경 요지 (2026-05-26 milestone-rewrite-audit §3 결정 사항):
--   1) subscriber_snapshots를 "마일스톤 첫 도달 시점"의 누적 기록으로 재정의.
--      같은 (channel_id, subscriber_count) 조합 중 가장 오래된 polled_at만 보존.
--   2) source 컬럼으로 출처 추적 — 'socialblade_milestone' | 'yutura_chart' |
--      'youtube_api_change'. 가중치 계산 시 source별 신뢰도 차등.
--   3) (channel_id, subscriber_count) 단위 unique index로 중복 재진입 방지.
--   4) poll_state — YouTube API 폴링 최신 상태(채널당 1행).
--   5) display_state — 화면 표시 상태(채널당 1행). 표시값은 항상 이 테이블 기준.
--   6) projected_subscriber_snapshots — 진단용이었으니 테이블·인덱스 모두 DROP.

-- 1. source 컬럼 추가
ALTER TABLE subscriber_snapshots ADD COLUMN source TEXT;

-- 2. (channel_id, subscriber_count) 중복 정리 — 가장 오래된 polled_at만 보존.
--    YouTube API가 10분 간격으로 동일값을 반복 INSERT하던 33k+ 행이 정리되어
--    "각 구독자 수에 처음 도달한 시점"의 마일스톤 기록만 남는다.
DELETE FROM subscriber_snapshots
 WHERE (channel_id, polled_at) NOT IN (
   SELECT channel_id, MIN(polled_at)
   FROM subscriber_snapshots
   GROUP BY channel_id, subscriber_count
 );

-- 3. source 마킹.
--    2026-05-18 = yutura-chart worker 첫 sweep 일자. 그 이전 자정 UTC 행은
--    2026-05-20 sb_backfill로 들어온 SocialBlade 60일 마일스톤 데이터.
UPDATE subscriber_snapshots SET source =
  CASE
    WHEN polled_at LIKE '%T00:00:00.000Z' AND polled_at < '2026-05-18T00:00:00.000Z'
      THEN 'socialblade_milestone'
    WHEN polled_at LIKE '%T00:00:00.000Z'
      THEN 'yutura_chart'
    ELSE 'youtube_api_change'
  END
 WHERE source IS NULL;

-- 4. 앞으로 동일 마일스톤 중복 INSERT 방지.
--    M2의 pollYoutubeChannels는 poll_state.api_subscriber_count와 비교해서
--    값이 변할 때만 INSERT하지만, 경합·재시도·수동 import 등에서의 중복도
--    DB 차원에서 차단한다.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriber_snapshots_unique_milestone
  ON subscriber_snapshots (channel_id, subscriber_count);

-- 5. poll_state — YouTube API 폴링 최신 상태.
--    cap = api + (next_milestone - api) * SAFETY_RATIO (M3에서 계산기 구현).
--    next_milestone은 api-bucket.ts 기준(<10M=1만, <100M=10만, ≥100M=100만 단위).
CREATE TABLE IF NOT EXISTS poll_state (
  channel_id                      TEXT PRIMARY KEY REFERENCES channels(id),
  api_subscriber_count            INTEGER NOT NULL,
  previous_api_subscriber_count   INTEGER,
  next_milestone                  INTEGER,
  cap_subscriber_count            INTEGER,
  last_polled_at                  TEXT NOT NULL,
  last_api_changed_at             TEXT,
  updated_at                      TEXT NOT NULL,
  created_at                      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_poll_state_last_polled_at
  ON poll_state (last_polled_at);

-- 6. display_state — 화면 표시 상태.
--    화면은 항상 display_subscriber_count를 읽는다. api_subscriber_count는 기준값.
--    next_change_at 도래 시 display-executor가 display_subscriber_count를 갱신하고
--    applied_change_count를 +1. plan_date가 바뀌면 display-planner가 새 plan 생성.
CREATE TABLE IF NOT EXISTS display_state (
  channel_id                  TEXT PRIMARY KEY REFERENCES channels(id),
  display_subscriber_count    INTEGER NOT NULL,
  target_subscriber_count     INTEGER NOT NULL,
  cap_subscriber_count        INTEGER NOT NULL,
  today_delta                 INTEGER NOT NULL DEFAULT 0,
  change_count                INTEGER NOT NULL DEFAULT 0,
  applied_change_count        INTEGER NOT NULL DEFAULT 0,
  next_change_at              TEXT,
  last_changed_at             TEXT,
  last_change_direction       TEXT,           -- 'up' | 'down' | NULL
  plan_date                   TEXT NOT NULL,  -- 'YYYY-MM-DD' UTC
  updated_at                  TEXT NOT NULL,
  created_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_display_state_next_change_at
  ON display_state (next_change_at);

-- 7. projected_subscriber_snapshots 제거. 한시 진단 인프라.
--    관련 worker(projection-sampler.ts) + snapshot.ts fallback 분기 + retention sweep도
--    같은 M1에서 코드 차원으로 제거.
DROP INDEX IF EXISTS idx_projected_subscriber_snapshots_sampled;
DROP INDEX IF EXISTS idx_projected_subscriber_snapshots_channel_sampled;
DROP TABLE IF EXISTS projected_subscriber_snapshots;
