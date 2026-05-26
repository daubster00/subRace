-- projected_subscriber_snapshots: 1분 주기 cron이 각 활성 채널에 대해
-- estimateSubscriberCount를 돌려 화면에 뿌려질 값을 기록한다.
--
-- 목적 (한시적 진단용):
--   현재 ISSEI(~75.4M, 30d 마일스톤 기준 시간당 ~1,528명) 채널이 실제 화면에서는
--   시간당 ~275명만 늘어나는 현상이 보고됨. 원인 후보:
--     1) snapshot.ts의 trend_baseline_count COALESCE가 의도와 다른 분기를 잡음
--     2) interpolation.ts cap/oscillation이 예상보다 빨리 발동
--     3) 클라이언트 모션 페이싱이 visible rate를 제한
--   세 가설을 구분하려면 "어떤 입력으로 어떤 출력이 나왔는지"의 시계열이 필요.
--   그래서 입력값(polled_count, growth_rate_per_hour, elapsed_seconds,
--   trend_baseline_count/_at)을 출력값(projected_count)과 함께 저장한다.
--
-- 사용:
--   - worker가 60초마다 모든 활성 채널을 한 행씩 insert
--   - readSnapshot은 최근(<5분) projected_count가 있으면 그 값을 SSR 화면값으로
--     쓰고, 없으면 fresh 계산 fallback
--   - 90일 retention sweep과 분리된 14일 retention (별도 cron)
--
-- 진단 완료 후 처리:
--   원인 확정 → projection/baseline 코드 수정 → 같은 테이블로 검증 →
--   본 테이블 + sampler + retention은 모두 제거. PRD에 정식 포함되는 기능이 아님.

CREATE TABLE IF NOT EXISTS projected_subscriber_snapshots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id           TEXT    NOT NULL,
  sampled_at           TEXT    NOT NULL,
  projected_count      INTEGER NOT NULL,
  polled_count         INTEGER NOT NULL,
  growth_rate_per_hour REAL,
  elapsed_seconds      REAL    NOT NULL,
  trend_baseline_count INTEGER,
  trend_baseline_at    TEXT
);

-- "각 채널의 가장 최근 샘플" 조회용 (readSnapshot의 첫 페인트 시드 lookup)
CREATE INDEX IF NOT EXISTS idx_projected_subscriber_snapshots_channel_sampled
  ON projected_subscriber_snapshots (channel_id, sampled_at DESC);

-- retention sweep용
CREATE INDEX IF NOT EXISTS idx_projected_subscriber_snapshots_sampled
  ON projected_subscriber_snapshots (sampled_at);
