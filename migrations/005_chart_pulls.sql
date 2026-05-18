-- chart_pulls: yutura 채널 상세 페이지(/channel/{id}/chart/) 폴링 및
-- 월별 백필 잡 이력. 두 잡 모두 subscriber_snapshots에 일자별 행을 추가하는
-- 동일한 패턴이라 단일 로그 테이블로 통합한다. kind로 잡 종류를 구분한다.
--
-- kind:
--   'chart'             - 일별 30일 milestone (1일 1회)
--   'monthly_backfill'  - 60일 전 시점 단일 데이터 포인트 (30일 1회)
--
-- snapshot.ts의 trend_baseline_count SQL이
--   1) 30일 이상 떨어진 행 중 현재와 다른 카운트(= 변화 있던 채널)
--   2) 1) 없으면 60일 이상 떨어진 행 (= 30일 정체 채널의 60일 baseline)
-- 순으로 lookup 하므로, monthly_backfill이 (2) 경로의 데이터 소스가 된다.
CREATE TABLE IF NOT EXISTS chart_pulls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,
  pulled_at      TEXT NOT NULL,
  status         TEXT NOT NULL,   -- 'success' | 'failed'
  channels_count INTEGER,
  rows_inserted  INTEGER,
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_chart_pulls_kind_pulled_at
  ON chart_pulls (kind, pulled_at);
