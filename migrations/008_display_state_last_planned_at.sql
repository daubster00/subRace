-- shouldReplan 회귀 수정 (2026-05-28).
--
-- 문제: 기존 shouldReplan은 display.updated_at을 비교 대상으로 썼는데, executor가
--       60s tick마다 매 step 적용 시 display_state.updated_at을 덮어쓰는 SET 컬럼에
--       포함시킴. 결과적으로 polling으로 last_api_changed_at이 갱신된 직후 executor가
--       한 번이라도 돌면 last_api_changed_at < updated_at 이 되어 planner가 영구히
--       replan을 skip. cap_subscriber_count가 옛 값에 갇혀 display가 api를 따라잡지
--       못하는 증상이 발생.
--
-- 수정: planner 전용 timestamp 컬럼 last_planned_at 도입. executor는 절대 건드리지
--       않음 → shouldReplan은 last_api_changed_at > last_planned_at로 정확히 판정.
--
-- 기존 행 복구: default '1970-01-01...' 으로 둬서 마이그레이션 직후 첫 planner tick에
-- 모든 채널이 자동 replan → cap·target·change_count 재계산 → 정상 복구.

ALTER TABLE display_state
  ADD COLUMN last_planned_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

CREATE INDEX IF NOT EXISTS idx_display_state_last_planned_at
  ON display_state (last_planned_at);
