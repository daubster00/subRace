import db from '@/lib/db';
import { env } from '@/lib/env';
import { type MilestoneRow } from '@/lib/milestone-delta';
import { planChannel } from '@/lib/schedule-plan';

// 채널 1개 플래닝 함수 (BUG-02 재구성).
//
// 구 주기적 planner(setInterval 전체 순회)는 폐기. channel-scheduler.ts가 두
// 트리거(사이클 만료 / 새 마일스톤)에서 채널별로 이 함수를 호출한다.
// 호출 = 무조건 재계획(언제 부를지는 트리거가 결정). 미적용 이벤트 DELETE →
// 새 1시간 스케줄 INSERT → display_state UPSERT를 한 트랜잭션으로 처리한다
// (이중 실행 방지 §지뢰①).

interface PollStateRow {
  api_subscriber_count: number;
  cap_subscriber_count: number | null;
}

interface DisplayRow {
  display_subscriber_count: number;
}

// BUG-01 fix: 날짜 window 제거, 최근 N개 순서 기반(전 소스). DESC LIMIT → reverse.
const MILESTONE_FETCH_LIMIT = 12;

const SELECT_POLL_STATE = `
  SELECT api_subscriber_count, cap_subscriber_count
  FROM   poll_state
  WHERE  channel_id = ?
`;

const SELECT_DISPLAY = `
  SELECT display_subscriber_count
  FROM   display_state
  WHERE  channel_id = ?
`;

const SELECT_MILESTONES = `
  SELECT polled_at, subscriber_count
  FROM   subscriber_snapshots
  WHERE  channel_id = ?
  ORDER  BY polled_at DESC
  LIMIT  ?
`;

const DELETE_UNAPPLIED_EVENTS = `
  DELETE FROM display_event_schedule WHERE channel_id = ? AND applied = 0
`;

const INSERT_EVENT = `
  INSERT INTO display_event_schedule
    (channel_id, scheduled_at, magnitude, direction, applied, created_at)
  VALUES (?, ?, ?, ?, 0, ?)
`;

// next_change_at은 항상 NULL(사장). plan_date/today_delta/change_count는 NOT NULL
// 충족용 레거시 값. last_changed_at/last_change_direction은 executor(=channel-
// scheduler) 소관이라 UPDATE에서 안 건드림.
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

const selectPoll       = db.prepare(SELECT_POLL_STATE);
const selectDisplay    = db.prepare(SELECT_DISPLAY);
const selectMilestones = db.prepare(SELECT_MILESTONES);
const deleteEvents     = db.prepare(DELETE_UNAPPLIED_EVENTS);
const insertEvent      = db.prepare(INSERT_EVENT);
const upsertDisplay    = db.prepare(UPSERT_DISPLAY_STATE);

export interface PlanResult {
  phase: 'fixed' | 'catch-up' | 'normal' | 'target-bounce';
  events: number;
  nextResetAt: string;
}

// 한 채널을 재계획한다. poll_state 없으면(아직 시드 안 됨) null.
export function planOneChannel(channelId: string, now: Date = new Date()): PlanResult | null {
  const poll = selectPoll.get(channelId) as PollStateRow | undefined;
  if (!poll) return null;

  const cycleMs = env.SCHEDULE_CYCLE_HOURS * 3_600_000;
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

  const api = poll.api_subscriber_count;
  const cap = poll.cap_subscriber_count ?? api;
  const display = (selectDisplay.get(channelId) as DisplayRow | undefined) ?? null;
  const milestones = (selectMilestones.all(channelId, MILESTONE_FETCH_LIMIT) as MilestoneRow[]).reverse();

  const plan = planChannel(api, display?.display_subscriber_count ?? null, milestones, cfg);

  const nowIso = now.toISOString();
  const nextResetIso = new Date(now.getTime() + cycleMs).toISOString();
  const legacyPlanDate = nowIso.slice(0, 10);

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
      plan.netDelta,
      plan.events.length,
      legacyPlanDate,
      nowIso,         // last_planned_at
      nextResetIso,   // next_cycle_reset_at
      plan.phase,
      nowIso,         // updated_at
      nowIso,         // created_at (INSERT만)
    );
  })();

  return { phase: plan.phase, events: plan.events.length, nextResetAt: nextResetIso };
}
