-- cap 개념 제거 (2026-06-09, customer-feedback-3).
--
-- 사전 스케줄 아키텍처에서 planner의 target이 사이클당 도달 지점을 정의한다.
-- 별도의 cap("api에서 다음 마일스톤의 85% 지점")이 target보다 낮게 깔려 있어
-- executor 안전망에서 +이벤트를 잘라 display가 cap에 갇히는 현상이 발생.
-- target 외 천장 개념이 없도록 cap 컬럼/관련 env(ESTIMATION_SAFETY_RATIO)를 제거한다.
--
-- SQLite 3.35+ supports ALTER TABLE DROP COLUMN.

ALTER TABLE poll_state    DROP COLUMN cap_subscriber_count;
ALTER TABLE display_state DROP COLUMN cap_subscriber_count;
