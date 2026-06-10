import db from '@/lib/db';

// 90일 이상 inactive 상태인 채널의 milestones + subscriber_snapshots + channels
// row를 모두 삭제한다. (자식 → channels 순서로 지워야 FK 의미상 안전.)
//
// inactive_since 기록은 worker/yutura.ts의 sweep과 migrations/004에서 채워진다.
// 활성 채널(is_active=1, inactive_since=NULL)은 절대 건드리지 않는다.
const RETENTION_THRESHOLD_DAYS = 90;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

function runRetentionSweep(): void {
  const cutoff = new Date(
    Date.now() - RETENTION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const targets = db
    .prepare(`
      SELECT id
      FROM   channels
      WHERE  is_active = 0
        AND  inactive_since IS NOT NULL
        AND  inactive_since < ?
    `)
    .all(cutoff) as { id: string }[];

  if (targets.length > 0) {
    const ids = targets.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');

    const purge = db.transaction(() => {
      db.prepare(
        `DELETE FROM milestones WHERE channel_id IN (${placeholders})`,
      ).run(...ids);
      db.prepare(
        `DELETE FROM subscriber_snapshots WHERE channel_id IN (${placeholders})`,
      ).run(...ids);
      db.prepare(`DELETE FROM channels WHERE id IN (${placeholders})`).run(...ids);
    });
    purge();

    console.log(
      `[worker] retention_sweep purged_channels=${ids.length} cutoff=${cutoff}`,
    );
  }
}

export function startRetentionScheduler(): void {
  // 워커 시작 직후 한 번, 그 뒤 24시간 주기.
  // 24h 안에 워커가 재시작돼도 재시작 직후 sweep이 한 번 더 돌 뿐이라 무해.
  runRetentionSweep();
  setInterval(runRetentionSweep, RETENTION_INTERVAL_MS);
}
