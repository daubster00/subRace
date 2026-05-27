import db from '@/lib/db';
import { env } from '@/lib/env';
import { getJstDate, getMsUntilJstMidnight } from '@/lib/time';
import { pickFirstIntervalMs } from '@/lib/display-plan';
import { decideDirection, pickStepMagnitude, applyStep } from '@/lib/display-execute';

// M5 display-executor — next_change_at 도래 채널의 display_subscriber_count를
// 실제로 한 칸씩 움직인다.
//
// 책임:
//   - due 채널 SELECT (plan_date = JST today, applied < count, next_change_at <= now)
//   - step magnitude / direction 결정 (display-execute.ts)
//   - display_subscriber_count 갱신 + applied_change_count +1 + 다음 next_change_at
//     (마지막이면 NULL) + last_changed_at / last_change_direction 기록
//
// 비책임 (M4 planner):
//   - 어떤 채널을 재계획할지 / target / today_delta / change_count
//
// plan_date = today 필터: 자정 직후 planner가 새 plan을 깔기 전에 executor가
// 어제 plan의 잔여 next_change_at으로 한 번 더 치는 케이스를 막는다.

interface DueRow {
  channel_id: string;
  display_subscriber_count: number;
  today_delta: number;
  change_count: number;
  applied_change_count: number;
  cap_subscriber_count: number;
  api_subscriber_count: number;
}

const SELECT_DUE = `
  SELECT d.channel_id,
         d.display_subscriber_count,
         d.today_delta,
         d.change_count,
         d.applied_change_count,
         d.cap_subscriber_count,
         p.api_subscriber_count
  FROM   display_state d
  JOIN   poll_state    p ON p.channel_id = d.channel_id
  WHERE  d.plan_date = ?
    AND  d.applied_change_count < d.change_count
    AND  d.next_change_at IS NOT NULL
    AND  d.next_change_at <= ?
`;

const UPDATE_DISPLAY = `
  UPDATE display_state
     SET display_subscriber_count = ?,
         applied_change_count     = applied_change_count + 1,
         next_change_at           = ?,
         last_changed_at          = ?,
         last_change_direction    = ?,
         updated_at               = ?
   WHERE channel_id = ?
`;

export interface ExecuteStats {
  due:       number;
  executed:  number;
  noopDelta: number; // 경계 클램프로 실제 변화량이 0이었던 횟수
  finalized: number; // 이 tick에서 마지막 이벤트를 친 채널 수 (next_change_at NULL로)
}

export function executePendingChanges(now: Date = new Date()): ExecuteStats {
  const stats: ExecuteStats = { due: 0, executed: 0, noopDelta: 0, finalized: 0 };

  const jstToday = getJstDate(now);
  const nowIso = now.toISOString();
  const remainingMs = getMsUntilJstMidnight(now);
  const jitterRatio = env.CHANGE_INTERVAL_JITTER_RATIO;

  const selectDue = db.prepare(SELECT_DUE);
  const update    = db.prepare(UPDATE_DISPLAY);

  const dueRows = selectDue.all(jstToday, nowIso) as DueRow[];
  stats.due = dueRows.length;
  if (dueRows.length === 0) return stats;

  const bias = {
    upMin:   env.CHANGE_BIAS_UP_INCREASE_MIN,
    upMax:   env.CHANGE_BIAS_UP_INCREASE_MAX,
    downMin: env.CHANGE_BIAS_DOWN_DECREASE_MIN,
    downMax: env.CHANGE_BIAS_DOWN_DECREASE_MAX,
  };

  // 한 batch 모두 단일 트랜잭션 — 수십~수백 행이라 ms 단위. 중간 실패 시 전체
  // 롤백되지만, 동기 native SQLite 호출이라 실패 가능성은 사실상 disk 에러뿐.
  const tx = db.transaction((rows: DueRow[]) => {
    for (const row of rows) {
      const direction = decideDirection({ todayDelta: row.today_delta, ...bias });
      const magnitude = pickStepMagnitude(row.api_subscriber_count);
      const { display, delta } = applyStep({
        display:   row.display_subscriber_count,
        direction,
        magnitude,
        api:       row.api_subscriber_count,
        cap:       row.cap_subscriber_count,
      });

      const newAppliedCount = row.applied_change_count + 1;
      const remainingChanges = row.change_count - newAppliedCount;
      let nextChangeAt: string | null;
      if (remainingChanges <= 0) {
        nextChangeAt = null;
        stats.finalized++;
      } else {
        const intervalMs = pickFirstIntervalMs({
          remainingMs,
          remainingChanges,
          jitterRatio,
        });
        nextChangeAt = new Date(now.getTime() + intervalMs).toISOString();
      }

      update.run(display, nextChangeAt, nowIso, direction, nowIso, row.channel_id);
      stats.executed++;
      if (delta === 0) stats.noopDelta++;
    }
  });

  tx(dueRows);
  return stats;
}
