import db from '@/lib/db';
import { env } from '@/lib/env';
import { type MilestoneRow } from '@/lib/milestone-delta';
import { planCatchUp, planTargetCycle } from '@/lib/schedule-plan';

// 채널 1개 플래닝 함수 (BUG-02 재구성).
//
// 구 주기적 planner(setInterval 전체 순회)는 폐기. channel-scheduler.ts가 두
// 트리거(사이클 만료 / 새 마일스톤)에서 채널별로 이 함수를 호출한다.
// 호출 = 무조건 재계획(언제 부를지는 트리거가 결정). 미적용 이벤트 DELETE →
// 새 1시간 스케줄 INSERT → display_state UPSERT를 한 트랜잭션으로 처리한다
// (이중 실행 방지 §지뢰①).

interface PollStateRow {
  api_subscriber_count: number;
}

interface DisplayRow {
  display_subscriber_count: number;
}

// BUG-01 fix: 날짜 window 제거, 최근 N개 순서 기반(전 소스). DESC LIMIT → reverse.
const MILESTONE_FETCH_LIMIT = 12;

const SELECT_POLL_STATE = `
  SELECT api_subscriber_count
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
    today_delta, change_count, applied_change_count,
    next_change_at, last_changed_at, last_change_direction,
    plan_date, last_planned_at, next_cycle_reset_at, phase,
    updated_at, created_at
  ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(channel_id) DO UPDATE SET
    display_subscriber_count = excluded.display_subscriber_count,
    target_subscriber_count  = excluded.target_subscriber_count,
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

// 트리거 종류 — caller(channel-scheduler)가 명시.
//   'milestone': YouTube 폴링이 새 마일스톤 감지 → catch-up 플랜
//                (현재 display값에서 새 api까지 1시간 안에 따라잡기).
//   'cycle'    : 사이클 만료(이벤트 소진 OR next_cycle_reset_at 도달) →
//                target 플랜 (마일스톤 추세 기반 normal/bounce/fixed).
//   'startup'  : 워커 부팅 시 첫 plan. 안전하게 target 플랜으로 시작.
export type PlanTrigger = 'milestone' | 'cycle' | 'startup';

// 한 채널을 재계획한다. poll_state 없으면(아직 시드 안 됨) null.
export function planOneChannel(
  channelId: string,
  trigger: PlanTrigger,
  now: Date = new Date(),
): PlanResult | null {
  const poll = selectPoll.get(channelId) as PollStateRow | undefined;
  if (!poll) return null;

  const cycleMs = env.SCHEDULE_CYCLE_HOURS * 3_600_000;
  const cfg = {
    minMilestones: env.SCHEDULE_MIN_MILESTONES,
    maxMagnitude: env.SCHEDULE_MAX_MAGNITUDE,
    normalMaxMagnitude: env.SCHEDULE_NORMAL_MAX_MAGNITUDE,
    cycleMs,
    catchUpIntervalMs: env.SCHEDULE_CATCHUP_INTERVAL_MS,
    targetRatio: env.SCHEDULE_TARGET_RATIO,
    bounceStepRatio: env.SCHEDULE_BOUNCE_STEP_RATIO,
    paceMaxIntervals: env.SCHEDULE_PACE_MAX_INTERVALS,
    jitterRatio: env.SCHEDULE_EVENT_JITTER_RATIO,
    bounceCount: env.SCHEDULE_BOUNCE_COUNT,
    trendMaxIntervals: env.SCHEDULE_TREND_MAX_INTERVALS,
    trendEpsilon: env.SCHEDULE_TREND_EPSILON,
  };

  const api = poll.api_subscriber_count;
  const display = (selectDisplay.get(channelId) as DisplayRow | undefined) ?? null;
  const currentDisplay = display?.display_subscriber_count ?? null;

  // milestone 트리거 → catch-up. 다른 트리거 → target.
  // catch-up은 마일스톤 추세를 보지 않으므로 milestones 쿼리도 생략 가능하지만,
  // target 트리거가 압도적이고 prepared statement 1회라 그대로 둔다.
  const milestones = (selectMilestones.all(channelId, MILESTONE_FETCH_LIMIT) as MilestoneRow[]).reverse();

  const plan = trigger === 'milestone'
    ? planCatchUp(api, currentDisplay, cfg)
    : planTargetCycle(api, currentDisplay, milestones, cfg, now);

  const nowIso = now.toISOString();
  // catch-up은 사이클 길이에 묶이지 않는다 — 마지막 이벤트가 끝난 직후를 사이클
  // 만료 시각으로 잡아 도중에 'cycle' 트리거가 catch-up 이벤트를 갈아엎지 않게
  // 한다 (2026-06-08). 나머지 phase는 종전대로 1h 롤링.
  const lastOffsetMs =
    plan.phase === 'catch-up' && plan.events.length > 0
      ? plan.events[plan.events.length - 1]!.offsetMs
      : -1;
  const cycleDurationMs = lastOffsetMs >= 0 ? lastOffsetMs + 5_000 : cycleMs;
  const nextResetIso = new Date(now.getTime() + cycleDurationMs).toISOString();
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
