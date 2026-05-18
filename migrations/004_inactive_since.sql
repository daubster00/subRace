-- channels.inactive_since: TOP150에서 마지막으로 빠진 시각(UTC ISO).
-- 활성 채널은 NULL. 90일 이상 inactive 상태인 채널은 retention sweep이
-- subscriber_snapshots + channels row를 함께 삭제한다.
--
-- 정책 (2026-05-18 합의): 이 마이그레이션 적용 시점에 이미 is_active=0인
-- 채널들은 "오늘부터 카운트 시작"이라는 사용자 결정에 따라 inactive_since를
-- 적용 시각으로 박는다. 그 뒤로 새로 빠지는 채널은 워커가 yutura sweep에서 set.
ALTER TABLE channels ADD COLUMN inactive_since TEXT;

UPDATE channels
SET inactive_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE is_active = 0 AND inactive_since IS NULL;

CREATE INDEX IF NOT EXISTS idx_channels_inactive_since
  ON channels (inactive_since);
