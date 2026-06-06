import db from '@/lib/db';
import { env } from '@/lib/env';
import { type MilestoneRow } from '@/lib/milestone-delta';
import { planChannel } from '@/lib/schedule-plan';

// 사전 스케줄 planner (2026-06-06 재작성, customer-feedback-2).
//
// 채널별 1시간 사이클의 모든 이벤트를 display_event_schedule에 미리 박는다.
// executor는 도래한 이벤트를 소비만 한다 (실행 시점 랜덤 결정 폐기).
//
// 재계획 트리거 (shouldReplan):
//   (a) display_state 없음 — 신규 채널
//   (b) now >= next_cycle_reset_at — 사이클 만료
//   (c) poll.last_api_changed_at > last_planned_at — mid-cycle API 변경
//   (d) phase='catch-up' AND display==api — catch-up 완료 즉시 normal 전환
//
// next_cycle_reset_at / last_planned_at은 planner 전용. executor는 절대 안 건드림
// (이중 실행 방지 §지뢰①). 이벤트 스케줄 테이블이 "다음 이벤트"의 단일 출처 —
// next_change_at은 NULL로만 쓴다(사장).
//
// phase:
//   fixed         = 마일스톤 < MIN_MILESTONES → api값 고정, 스케줄 없음 (2026-06-06 결정)
//   catch-up      = display != api → 1시간 안에 api 도달, 100% 추세 방향
//   normal        = target(95%) 향해 시간당 목표만큼, 80/20 방향
//   target-bounce = target 도달/정체 → ±3% bucket unit 진동, net 0

interface PollStateRow {
  channel_id: string;
  api_subscriber_count: number;
  cap_subscriber_count: number | null;
  last_api_changed_at: string | null;
}

interface DisplayStateRow {
  channel_id: string;
  display_subscriber_count: number;
  phase: string | null;
  next_cycle_reset_at: string | null;
  last_planned_at: string;
}

const SELECT_RANKED_ACTIVE = `
  SELECT ps.channel_id
  FROM   poll_state ps
  JOIN   channels c ON c.id = ps.channel_id
  WHERE  c.is_active = 1
  ORDER  BY ps.api_subscriber_count DESC
`;

const SELECT_POLL_STATE = `
  SELECT channel_id, api_subscriber_count, cap_subscriber_count, last_api_changed_at
  FROM   poll_state
  WHERE  channel_id = ?
`;

const SELECT_DISPLAY_STATE = `
  SELECT channel_id, display_subscriber_count, phase, next_cycle_reset_at, last_planned_at
  FROM   display_state
  WHERE  channel_id = ?
`;

const SELECT_MILESTONES = `
  SELECT polled_at, subscriber_count
  FROM   subscriber_snapshots
  WHERE  channel_id = ?
    AND  polled_at >= ?
  ORDER  BY polled_at
`;

const DELETE_UNAPPLIED_EVENTS = `
  DELETE FROM display_event_schedule WHERE channel_id = ? AND applied = 0
`;

const INSERT_EVENT = `
  INSERT INTO display_event_schedule
    (channel_id, scheduled_at, magnitude, direction, applied, created_at)
  VALUES (?, ?, ?, ?, 0, ?)
`;

// display_subscriber_count는 executor가 사이클 중 전진시킨 값을 유지한다 — replan은
// 그 값에서 이어서 스케줄을 새로 깐다 (fixed만 api로 덮어씀). last_changed_at /
// last_change_direction은 executor 소관이라 UPDATE에서 건드리지 않는다.
// next_change_at은 항상 NULL (스케줄 테이블이 단일 출처). plan_date/today_delta/
// change_count는 NOT NULL 제약 충족용 레거시 값.
const UPSERT_DISPLAY_STATE = `
  INSERT INTO display_state (
    channel_id, display_subscriber_count, target_subscriber_count,
    cap_subscriber_count, today_delta, change_count, applied_change_count,
    next_change_at, last_changed_at, last_change_direction,
    plan_date, last_planned_at, next_cycle_reset_at, phase,
    updated_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(channel_id) DO UPDATE SET
    display_subscriber_count = excluded.display_subscriber_count,
    target_subscriber_count  = excluded.target_subscriber_count,
    cap_subscriber_count     = excluded.cap_subscriber_count,
    today_delta              = excluded.today_delta,
    change_count             = excluded.change_count,
    applied_change_count     = 0,
    next_change_at           = NULL,
    plan_date                = excluded.plan_date,
    last_planned_at          = excluded.last_planned_at,
    next_cycle_reset_at      = excluded.next_cycle_reset_at,
    phase                    = excluded.phase,
    updated_at               = excluded.updated_at
`;

function shouldReplan(
  display: DisplayStateRow | null,
  poll: PollStateRow,
  now: Date,
): boolean {
  if (!display) return true;
  if (!display.next_cycle_reset_at) return true;
  if (now.getTime() >= new Date(display.next_cycle_reset_at).getTime()) return true;
  if (poll.last_api_changed_at) {
    if (new Date(poll.last_api_changed_at).getTime() > new Date(display.last_planned_at).getTime()) {
      return true;
    }
  }
  // catch-up 완료 즉시 전환: 도달했으면 다음 사이클 안 기다리고 재계획.
  if (display.phase === 'catch-up' && display.display_subscriber_count === poll.api_subscriber_count) {
    return true;
  }
  return false;
}

export interface PlanStats {
  considered: number;
  planned: number;
  fixed: number;
  skipped: number;
  noPollState: number;
}

export function planAllActiveChannels(now: Date = new Date()): PlanStats {
  const stats: PlanStats = { considered: 0, planned: 0, fixed: 0, skipped: 0, noPollState: 0 };

  const ranked = db.prepare(SELECT_RANKED_ACTIVE).all() as { channel_id: string }[];
  const cutoff = new Date(now.getTime() - env.MILESTONE_HISTORY_WINDOW_DAYS * 86_400_000).toISOString();
  const cycleMs = env.SCHEDULE_CYCLE_HOURS * 3_600_000;
  const nowIso = now.toISOString();
  const nextResetIso = new Date(now.getTime() + cycleMs).toISOString();
  const legacyPlanDate = nowIso.slice(0, 10); // NOT NULL 충족용 (사장 컬럼)

  const cfg = {
    minMilestones: env.SCHEDULE_MIN_MILESTONES,
    minEvents: env.SCHEDULE_MIN_EVENTS,
    maxMagnitude: env.SCHEDULE_MAX_MAGNITUDE,
    counterRatio: env.SCHEDULE_COUNTER_RATIO,
    cycleMs,
    targetRatio: env.SCHEDULE_TARGET_RATIO,
    bounceStepRatio: env.SCHEDULE_BOUNCE_STEP_RATIO,
    paceMaxIntervals: env.SCHEDULE_PACE_MAX_INTERVALS,
    jitterRatio: env.SCHEDULE_EVENT_JITTER_RATIO,
  };

  const selectPoll       = db.prepare(SELECT_POLL_STATE);
  const selectDisplay    = db.prepare(SELECT_DISPLAY_STATE);
  const selectMilestones = db.prepare(SELECT_MILESTONES);
  const deleteEvents     = db.prepare(DELETE_UNAPPLIED_EVENTS);
  const insertEvent      = db.prepare(INSERT_EVENT);
  const upsertDisplay    = db.prepare(UPSERT_DISPLAY_STATE);

  for (const { channel_id: channelId } of ranked) {
    stats.considered++;

    const poll = selectPoll.get(channelId) as PollStateRow | undefined;
    if (!poll) {
      stats.noPollState++;
      continue;
    }

    const display = (selectDisplay.get(channelId) as DisplayStateRow | undefined) ?? null;
    if (!shouldReplan(display, poll, now)) {
      stats.skipped++;
      continue;
    }

    const api = poll.api_subscriber_count;
    const cap = poll.cap_subscriber_count ?? api;
    const milestones = selectMilestones.all(channelId, cutoff) as MilestoneRow[];

    const plan = planChannel(api, display?.display_subscriber_count ?? null, milestones, cfg);

    // 재시작/재계획 시 미적용 이벤트 DELETE → 재삽입 + display_state UPSERT를
    // 한 트랜잭션으로 (이중 실행 방지 §지뢰①).
    db.transaction(() => {
      deleteEvents.run(channelId);
      for (const e of plan.events) {
        const scheduledAt = new Date(now.getTime() + e.offsetMs).toISOString();
        const direction = e.magnitude > 0 ? 'up' : e.magnitude < 0 ? 'down' : 'up';
        insertEvent.run(channelId, scheduledAt, e.magnitude, direction, nowIso);
      }
      upsertDisplay.run(
        channelId,
        plan.display,
        plan.target,
        cap,
        plan.netDelta,        // today_delta (관측용)
        plan.events.length,   // change_count (관측용)
        legacyPlanDate,
        nowIso,               // last_planned_at
        nextResetIso,         // next_cycle_reset_at
        plan.phase,
        nowIso,               // updated_at
        nowIso,               // created_at (INSERT만 적용)
      );
    })();

    if (plan.phase === 'fixed') stats.fixed++;
    else stats.planned++;
  }

  return stats;
}
