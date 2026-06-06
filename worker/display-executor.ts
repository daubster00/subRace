import db from '@/lib/db';

// 사전 스케줄 executor (2026-06-06 재작성, customer-feedback-2).
//
// display_event_schedule에서 도래한(applied=0 AND scheduled_at <= now) 이벤트를
// 소비해 display_subscriber_count를 magnitude만큼 이동시킨다. 방향·크기는 planner가
// 이미 확정했으므로 executor는 결정하지 않는다 (구 decideDirection/pickStepMagnitude 폐기).
//
// executor가 건드리는 것: display_subscriber_count, last_changed_at,
//   last_change_direction, updated_at, applied_change_count(관측), 이벤트의 applied.
// executor가 절대 안 건드리는 것: next_cycle_reset_at, last_planned_at, phase,
//   target/cap (planner 소관 — 이중 실행/회귀 방지 §지뢰①).

interface DueEventRow {
  id: number;
  channel_id: string;
  magnitude: number;
  display_subscriber_count: number;
  cap_subscriber_count: number;
}

// scheduled_at, id 순서로 — 같은 채널에 여러 이벤트가 동시 도래해도 순차 적용.
const SELECT_DUE = `
  SELECT e.id, e.channel_id, e.magnitude,
         d.display_subscriber_count, d.cap_subscriber_count
  FROM   display_event_schedule e
  JOIN   display_state d ON d.channel_id = e.channel_id
  WHERE  e.applied = 0
    AND  e.scheduled_at <= ?
  ORDER  BY e.scheduled_at, e.id
`;

const MARK_APPLIED = `
  UPDATE display_event_schedule SET applied = 1, applied_at = ? WHERE id = ?
`;

// last_change_direction은 magnitude=0(bounce 홀수 보정)일 때 기존 값 유지(COALESCE).
const UPDATE_DISPLAY = `
  UPDATE display_state
     SET display_subscriber_count = ?,
         last_changed_at          = ?,
         last_change_direction    = COALESCE(?, last_change_direction),
         applied_change_count     = applied_change_count + 1,
         updated_at               = ?
   WHERE channel_id = ?
`;

export interface ExecuteStats {
  due:       number;
  executed:  number;
  channels:  number; // 이 tick에서 표시값이 움직인 채널 수
  noopDelta: number; // cap/floor 클램프로 실제 변화 0이었던 횟수
}

export function executePendingChanges(now: Date = new Date()): ExecuteStats {
  const stats: ExecuteStats = { due: 0, executed: 0, channels: 0, noopDelta: 0 };

  const nowIso = now.toISOString();
  const selectDue = db.prepare(SELECT_DUE);
  const markApplied = db.prepare(MARK_APPLIED);
  const updateDisplay = db.prepare(UPDATE_DISPLAY);

  const dueRows = selectDue.all(nowIso) as DueEventRow[];
  stats.due = dueRows.length;
  if (dueRows.length === 0) return stats;

  // 같은 채널 여러 이벤트의 누적 표시값을 in-memory로 추적 (SELECT 시점 display는
  // 모두 동일한 stale 값이라, 순차 적용하려면 running value가 필요).
  const running = new Map<string, number>();

  db.transaction(() => {
    for (const row of dueRows) {
      const cur = running.get(row.channel_id) ?? row.display_subscriber_count;
      // 안전망 클램프 — 스케줄 net이 이미 target/api에 정확히 떨어지므로 정상
      // 경로에선 작동 안 함. cap 추월 / 음수만 방어.
      let next = cur + row.magnitude;
      if (next > row.cap_subscriber_count) next = row.cap_subscriber_count;
      if (next < 1) next = 1;

      const direction = row.magnitude > 0 ? 'up' : row.magnitude < 0 ? 'down' : null;

      markApplied.run(nowIso, row.id);
      updateDisplay.run(next, nowIso, direction, nowIso, row.channel_id);

      if (next === cur) stats.noopDelta++;
      running.set(row.channel_id, next);
      stats.executed++;
    }
  })();

  stats.channels = running.size;
  return stats;
}
