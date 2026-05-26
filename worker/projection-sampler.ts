import db from '@/lib/db';
import { env } from '@/lib/env';
import { estimateSubscriberCount } from '@/lib/interpolation';

// 60초마다 모든 활성 채널의 화면 예상값(= estimateSubscriberCount 출력)을 기록.
//
// 왜 한시적인지: docs/plans/2026-05-26-projection-sampler-diagnostic.md 참고.
// 요약하면 ISSEI/ADO에서 실제 화면 증가속도가 30d 마일스톤 기준 rate와
// 크게 어긋난다는 고객 보고가 있어, 어디서 어긋나는지 시계열로 추적하기 위한
// 임시 진단 인프라.
//
// 입력값(polled_count, growth_rate_per_hour, elapsed_seconds, trend_baseline_*)을
// 출력값(projected_count)과 함께 한 행으로 박아넣어, 한 SQL로
// "어떤 baseline 분기가 잡혔고 그래서 rate가 어떻게 계산됐고 그 결과 화면이
// 어디까지 갔는지"를 한눈에 볼 수 있게 한다.

const SAMPLE_INTERVAL_MS = 60_000;

interface SamplerRow {
  channel_id: string;
  subscriber_count: number;
  polled_at: string | null;
  trend_baseline_count: number | null;
  trend_baseline_at: string | null;
}

function runSample(): void {
  const startMs = Date.now();
  const sampledAt = new Date(startMs).toISOString();
  const safetyRatio = env.ESTIMATION_SAFETY_RATIO;

  // snapshot.ts의 trend_baseline COALESCE를 그대로 재현. 활성 채널 전체를
  // BACKGROUND_LIMIT까지 (DISPLAY_LIMIT은 50밖에 안 됨 — 우리는 150개 전부 필요).
  const rows = db
    .prepare(
      `
      SELECT
        c.id AS channel_id,
        COALESCE(s.subscriber_count, 0) AS subscriber_count,
        s.polled_at,
        COALESCE(
          (
            SELECT ss_t.subscriber_count
            FROM   subscriber_snapshots ss_t
            WHERE  ss_t.channel_id = c.id
              AND  s.polled_at IS NOT NULL
              AND  julianday(s.polled_at) - julianday(ss_t.polled_at) >= 30.0
              AND  ss_t.subscriber_count != s.subscriber_count
            ORDER  BY ss_t.polled_at DESC
            LIMIT  1
          ),
          (
            SELECT ss_60.subscriber_count
            FROM   subscriber_snapshots ss_60
            WHERE  ss_60.channel_id = c.id
              AND  s.polled_at IS NOT NULL
              AND  julianday(s.polled_at) - julianday(ss_60.polled_at) >= 60.0
            ORDER  BY ss_60.polled_at DESC
            LIMIT  1
          ),
          (
            SELECT ss_old.subscriber_count
            FROM   subscriber_snapshots ss_old
            WHERE  ss_old.channel_id = c.id
              AND  s.polled_at IS NOT NULL
              AND  ss_old.polled_at < s.polled_at
            ORDER  BY ss_old.polled_at ASC
            LIMIT  1
          )
        ) AS trend_baseline_count,
        COALESCE(
          (
            SELECT ss_t.polled_at
            FROM   subscriber_snapshots ss_t
            WHERE  ss_t.channel_id = c.id
              AND  s.polled_at IS NOT NULL
              AND  julianday(s.polled_at) - julianday(ss_t.polled_at) >= 30.0
              AND  ss_t.subscriber_count != s.subscriber_count
            ORDER  BY ss_t.polled_at DESC
            LIMIT  1
          ),
          (
            SELECT ss_60.polled_at
            FROM   subscriber_snapshots ss_60
            WHERE  ss_60.channel_id = c.id
              AND  s.polled_at IS NOT NULL
              AND  julianday(s.polled_at) - julianday(ss_60.polled_at) >= 60.0
            ORDER  BY ss_60.polled_at DESC
            LIMIT  1
          ),
          (
            SELECT ss_old.polled_at
            FROM   subscriber_snapshots ss_old
            WHERE  ss_old.channel_id = c.id
              AND  s.polled_at IS NOT NULL
              AND  ss_old.polled_at < s.polled_at
            ORDER  BY ss_old.polled_at ASC
            LIMIT  1
          )
        ) AS trend_baseline_at
      FROM   channels c
      LEFT JOIN subscriber_snapshots s
        ON  s.channel_id = c.id
        AND s.polled_at  = (
              SELECT MAX(ss.polled_at)
              FROM   subscriber_snapshots ss
              WHERE  ss.channel_id = c.id
            )
      WHERE c.is_active = 1
      ORDER BY COALESCE(s.subscriber_count, 0) DESC
      LIMIT ?
    `,
    )
    .all(env.BACKGROUND_LIMIT) as SamplerRow[];

  if (rows.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO projected_subscriber_snapshots
      (channel_id, sampled_at, projected_count, polled_count,
       growth_rate_per_hour, elapsed_seconds,
       trend_baseline_count, trend_baseline_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const commit = db.transaction((batch: SamplerRow[]) => {
    for (const row of batch) {
      if (row.subscriber_count <= 0 || !row.polled_at) continue;

      const trendHours =
        row.trend_baseline_count != null && row.trend_baseline_at
          ? (startMs - new Date(row.trend_baseline_at).getTime()) / 3_600_000
          : null;
      const trendDelta =
        row.trend_baseline_count != null && trendHours != null && trendHours > 0
          ? row.subscriber_count - row.trend_baseline_count
          : null;
      const growthRatePerHour =
        trendDelta != null && trendHours != null && trendHours > 0
          ? trendDelta / trendHours
          : null;

      const elapsedSeconds = Math.max(
        0,
        (startMs - new Date(row.polled_at).getTime()) / 1000,
      );

      const projectedCount = estimateSubscriberCount({
        polledCount: row.subscriber_count,
        growthRatePerHour,
        elapsedSeconds,
        safetyRatio,
      });

      insert.run(
        row.channel_id,
        sampledAt,
        projectedCount,
        row.subscriber_count,
        growthRatePerHour,
        elapsedSeconds,
        row.trend_baseline_count,
        row.trend_baseline_at,
      );
    }
  });

  try {
    commit(rows);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] projection_sample_failed reason=${message}`);
    return;
  }

  const durationMs = Date.now() - startMs;
  console.log(
    `[worker] projection_sample_success channels=${rows.length} duration_ms=${durationMs}`,
  );
}

export function startProjectionSampler(): void {
  runSample();
  setInterval(runSample, SAMPLE_INTERVAL_MS);
}
