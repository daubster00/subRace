-- milestones: 추세 판정·display planner의 단일 진실 공급원(SSOT).
--
-- 배경(2026-06-10): 기존 subscriber_snapshots에 socialblade_milestone과
-- youtube_api_change가 섞여 들어가, YouTube API 라운딩 떨림(예: 75,700↔75,600)이
-- 추세 가중치를 깎아 진짜 상승 채널이 정체로 잡히는 사고가 다발. 두 source를
-- 별도 보관 후 합쳐 쓰던 모델 자체가 원인.
--
-- 새 모델: 입력 시점에 dedup 규칙을 적용한 한 테이블만 유지한다.
--   - 백필: subscriber_snapshots의 SocialBlade row 전체 + YouTube row 중
--     (같은 날짜 SB row 있으면 SKIP, 직전 row와 값이 같으면 SKIP)
--   - 런타임: YouTube API 폴링이 직전 row와 값 다를 때만 INSERT
--
-- subscriber_snapshots는 그대로 두고 추가 INSERT만 멈춘다(과거 데이터 보존용).
-- 모든 마일스톤 참조 연산은 이 milestones 테이블로 옮긴다.
CREATE TABLE IF NOT EXISTS milestones (
  channel_id        TEXT NOT NULL REFERENCES channels(id),
  recorded_at       TEXT NOT NULL,
  subscriber_count  INTEGER NOT NULL,
  video_count       INTEGER,
  view_count        INTEGER,
  source            TEXT NOT NULL,
  PRIMARY KEY (channel_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS milestones_channel_at_desc_idx
  ON milestones (channel_id, recorded_at DESC);
