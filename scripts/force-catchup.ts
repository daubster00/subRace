// catch-up 강제 재계획 — 호스트의 새 코드(planCatchUp)로 미적용 이벤트 갈아끼우기.
//
// 전제:
//   1) docker stop subrace-worker subrace-web (DB WAL 충돌 방지, [[db_lock_with_docker]])
//   2) npx tsx scripts/force-catchup.ts
//   3) docker compose up -d --build (워커 새 이미지로 재기동)
//
// 동작:
//   display !== api 인 활성 채널을 찾아 planOneChannel(..., 'milestone') 호출.
//   planOneChannel이 미적용 이벤트 DELETE + 새 catch-up 스케줄 INSERT + display_state
//   UPSERT를 한 트랜잭션으로 수행.
import db from '@/lib/db';
import { planOneChannel } from '../worker/display-planner';

interface Row {
  channel_id: string;
  api: number;
  disp: number;
}

const rows = db
  .prepare(
    `
    SELECT ps.channel_id,
           ps.api_subscriber_count    AS api,
           ds.display_subscriber_count AS disp
    FROM   poll_state ps
    JOIN   display_state ds ON ds.channel_id = ps.channel_id
    JOIN   channels c       ON c.id          = ps.channel_id
    WHERE  c.is_active = 1
      AND  ds.display_subscriber_count IS NOT NULL
      AND  ds.display_subscriber_count <> ps.api_subscriber_count
    ORDER  BY ABS(ps.api_subscriber_count - ds.display_subscriber_count) DESC
  `,
  )
  .all() as Row[];

console.log(`catch-up replan candidates: ${rows.length}`);
if (rows.length === 0) {
  console.log('no channels need catch-up (display == api everywhere).');
  db.close();
  process.exit(0);
}

console.log(
  'channel                  | gap     | phase     | events | total time',
);
console.log(
  '-------------------------|---------|-----------|--------|-----------',
);

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

let ok = 0;
for (const r of rows) {
  const gap = r.api - r.disp;
  try {
    const result = planOneChannel(r.channel_id, 'milestone');
    if (!result) {
      console.log(
        `${r.channel_id.padEnd(24)} | ${String(gap).padStart(7)} | (no poll_state)`,
      );
      continue;
    }
    const last = db
      .prepare(
        `SELECT MAX(scheduled_at) AS t FROM display_event_schedule WHERE channel_id = ? AND applied = 0`,
      )
      .get(r.channel_id) as { t: string | null };
    const totalMs = last.t ? new Date(last.t).getTime() - Date.now() : 0;
    console.log(
      `${r.channel_id.padEnd(24)} | ${String(gap).padStart(7)} | ${result.phase.padEnd(9)} | ${String(result.events).padStart(6)} | ${fmtMs(totalMs)}`,
    );
    ok++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${r.channel_id.padEnd(24)} | FAILED ${msg}`);
  }
}

console.log(`\ndone — ${ok}/${rows.length} replanned`);
db.close();
