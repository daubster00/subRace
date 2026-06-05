-- 마일스톤 재진입 허용:
-- 007에서 (channel_id, subscriber_count) UNIQUE를 걸어 "각 값에 처음 도달한 시점"만
-- 보존했지만, 운영 중 구독자 수가 떨어졌다가 다시 같은 값에 도달하는 케이스도
-- 별개의 마일스톤으로 찍어야 한다.
--
-- 정책 변경 후 의미:
--   subscriber_snapshots = "이전 관측값과 달라질 때마다 찍는 변화 이력".
--   (channel_id, polled_at) PK는 그대로 유지되어 동일 폴링 시각 중복은 차단된다.
--   "최신값과 다를 때만 INSERT"는 worker/youtube-channels.ts가 poll_state 비교로 보장.

DROP INDEX IF EXISTS idx_subscriber_snapshots_unique_milestone;
