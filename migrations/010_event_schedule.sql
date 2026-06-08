-- 사전 스케줄 아키텍처 전환 (2026-06-06, customer-feedback-2).
--
-- 기존: planner가 today_delta/change_count/첫 next_change_at만 박고, executor가
--       실행 시점에 방향·크기를 랜덤 결정 (decideDirection/pickStepMagnitude).
-- 신규: planner가 채널별 1시간 사이클의 모든 이벤트(시각·부호 있는 magnitude)를
--       display_event_schedule에 미리 박고, executor는 도래한 이벤트를 소비만 한다.
--
-- 이 마이그레이션은 순수 additive다. 사장 컬럼(plan_date/today_delta/change_count/
-- next_change_at)은 즉시 DROP하지 않는다 — 새 경로가 검증된 뒤 별도 마이그레이션에서
-- 정리한다 (지뢰 분석 §migration 전략). SQLite DROP COLUMN 제약 회피 + 롤백 여지.

-- 1. 이벤트 스케줄 테이블 — "다음 이벤트"의 단일 출처.
--    magnitude는 부호 있는 정수 (+ 증가 / − 감소). direction은 표시/디버깅용 중복.
--    applied=0 인 행만 executor가 소비. 재계획 시 applied=0 행은 DELETE 후 재삽입.
CREATE TABLE IF NOT EXISTS display_event_schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT NOT NULL REFERENCES channels(id),
  scheduled_at  TEXT NOT NULL,            -- ISO UTC. executor는 scheduled_at <= now 인 행 소비
  magnitude     INTEGER NOT NULL,         -- 부호 있음. |magnitude| <= 20 (planner가 보장)
  direction     TEXT NOT NULL,            -- 'up' | 'down'
  applied       INTEGER NOT NULL DEFAULT 0,
  applied_at    TEXT,
  created_at    TEXT NOT NULL
);

-- due 조회용: applied=0 AND scheduled_at <= now 를 빠르게.
CREATE INDEX IF NOT EXISTS idx_event_schedule_due
  ON display_event_schedule (applied, scheduled_at);
-- 재계획 시 채널별 미적용 이벤트 DELETE 용.
CREATE INDEX IF NOT EXISTS idx_event_schedule_channel
  ON display_event_schedule (channel_id, applied);

-- 2. display_state 신규 컬럼.
--    next_cycle_reset_at: 채널별 1시간 롤링 사이클 기준 시각. 이 시각이 지나면
--      planner가 재계획. executor는 이 컬럼을 절대 건드리지 않는다 (이중 실행 §지뢰①).
--    phase: 'fixed' | 'catch-up' | 'normal' | 'target-bounce'.
--      fixed     = 마일스톤 6개 미만 → api값 고정 표시, 스케줄 없음.
--      catch-up  = 새 마일스톤 도래 → 1시간 안에 api값 도달, 100% 추세 방향.
--      normal    = target(95%) 향해 시간당 목표만큼 이동, 80/20 방향.
--      target-bounce = target 도달 → ±3% step 진동.
ALTER TABLE display_state ADD COLUMN next_cycle_reset_at TEXT;
ALTER TABLE display_state ADD COLUMN phase TEXT;

CREATE INDEX IF NOT EXISTS idx_display_state_next_cycle_reset_at
  ON display_state (next_cycle_reset_at);
