import db from '@/lib/db';
import { env } from '@/lib/env';
import { computeExpectedDailyDelta, type MilestoneRow } from '@/lib/milestone-delta';
import { getJstDate, getMsUntilJstMidnight } from '@/lib/time';
import {
  computeTargetAndDelta,
  decideChangeCount,
  decideTier,
  getFallbackDailyDelta,
  getStepBounds,
  pickFirstIntervalMs,
  shouldReplan,
} from '@/lib/display-plan';

// M4 display-planner — 채널별 daily plan을 display_state에 박는다.
//
// 책임 범위:
//   - 어떤 채널을 재계획할지 결정 (shouldReplan)
//   - 오늘의 target / today_delta / change_count / next_change_at 계산
//   - display_state UPSERT (display_subscriber_count는 신규 시드 시 api로,
//     기존이면 유지)
//
// 비책임 (M5 executor):
//   - next_change_at 도래 시 display_subscriber_count 실제 갱신
//   - 이벤트별 step size / 증감 방향 선택
//   - 이벤트마다 다음 next_change_at 재산정
//
// 순수 결정 함수는 src/lib/display-plan.ts에서 import — 단위 테스트는 거기서.

interface PollStateRow {
  channel_id: string;
  api_subscriber_count: number;
  cap_subscriber_count: number | null;
  last_polled_at: string;
  last_api_changed_at: string | null;
}

interface DisplayStateRow {
  channel_id: string;
  display_subscriber_count: number;
  plan_date: string;
  last_planned_at: string;
}

// noop 채널 — channels 테이블에 있지만 아직 poll_state 시드 안 됨.
// pollYoutubeChannels가 처음 돌면 자동 시드됨, planner는 다음 cycle에 처리.
// 순서가 rank — display_state.next_change_at 빈도(노출/대기) 결정에 직접 영향.
const SELECT_RANKED_ACTIVE = `
  SELECT ps.channel_id
  FROM   poll_state ps
  JOIN   channels c ON c.id = ps.channel_id
  WHERE  c.is_active = 1
  ORDER  BY ps.api_subscriber_count DESC
`;

const SELECT_POLL_STATE = `
  SELECT channel_id, api_subscriber_count, cap_subscriber_count,
         last_polled_at, last_api_changed_at
  FROM   poll_state
  WHERE  channel_id = ?
`;

const SELECT_DISPLAY_STATE = `
  SELECT channel_id, display_subscriber_count, plan_date, last_planned_at
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

// display_state UPSERT — 신규는 INSERT(display = api), 기존은 UPDATE
// (display_subscriber_count는 max(stored, api)로 — api 아래에 갇혀 있던 값은
// 끌어올리고, 정상값은 유지). applied_change_count는 항상 0으로 리셋
// (day rollover든 mid-day API 변경 replan이든 새 계획으로 교체).
//
// last_planned_at은 planner 전용 timestamp — executor의 매 step UPDATE는 절대
// 이걸 건드리지 않는다. shouldReplan이 last_api_changed_at과 정확히 비교할 수
// 있게 만들어진 컬럼. updated_at은 화면 forward-projection의 reference time
// 용도라 executor가 갱신해야 함.
const UPSERT_DISPLAY_STATE = `
  INSERT INTO display_state (
    channel_id, display_subscriber_count, target_subscriber_count,
    cap_subscriber_count, today_delta, change_count, applied_change_count,
    next_change_at, last_changed_at, last_change_direction,
    plan_date, last_planned_at, updated_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, ?)
  ON CONFLICT(channel_id) DO UPDATE SET
    display_subscriber_count = excluded.display_subscriber_count,
    target_subscriber_count = excluded.target_subscriber_count,
    cap_subscriber_count    = excluded.cap_subscriber_count,
    today_delta             = excluded.today_delta,
    change_count            = excluded.change_count,
    applied_change_count    = 0,
    next_change_at          = excluded.next_change_at,
    plan_date               = excluded.plan_date,
    last_planned_at         = excluded.last_planned_at,
    updated_at              = excluded.updated_at
`;

export interface PlanStats {
  considered: number;
  planned: number;
  skipped: number;
  noPollState: number;
}

export function planAllActiveChannels(now: Date = new Date()): PlanStats {
  const stats: PlanStats = { considered: 0, planned: 0, skipped: 0, noPollState: 0 };

  const ranked = db.prepare(SELECT_RANKED_ACTIVE).all() as { channel_id: string }[];
  const jstToday = getJstDate(now);
  const cutoff = new Date(now.getTime() - env.MILESTONE_HISTORY_WINDOW_DAYS * 86_400_000).toISOString();
  const halfLife = env.MILESTONE_WEIGHT_HALF_LIFE_DAYS;
  const jitterRatio = env.CHANGE_INTERVAL_JITTER_RATIO;
  const displayLimit = env.DISPLAY_LIMIT;
  const bufferSize = 20; // 노출 진입 buffer (active_plan)

  const selectPoll       = db.prepare(SELECT_POLL_STATE);
  const selectDisplay    = db.prepare(SELECT_DISPLAY_STATE);
  const selectMilestones = db.prepare(SELECT_MILESTONES);
  const upsert           = db.prepare(UPSERT_DISPLAY_STATE);

  const nowIso = now.toISOString();
  const remainingMs = getMsUntilJstMidnight(now);

  for (let i = 0; i < ranked.length; i++) {
    const row = ranked[i];
    if (!row) continue;
    const channelId = row.channel_id;
    const rank = i + 1;
    stats.considered++;

    const poll = selectPoll.get(channelId) as PollStateRow | undefined;
    if (!poll) {
      stats.noPollState++;
      continue;
    }

    const display = (selectDisplay.get(channelId) as DisplayStateRow | undefined) ?? null;
    if (!shouldReplan({ display, poll, jstToday })) {
      stats.skipped++;
      continue;
    }

    const api = poll.api_subscriber_count;
    // cap_subscriber_count는 M2에서 함께 박혔지만 NULL 보호.
    const cap = poll.cap_subscriber_count ?? api;
    // display는 api 아래로 내려가지 않는다. 회귀 수정 이전 데이터(planner가
    // skip되어 cap이 옛 값에 갇혀 display가 api보다 뒤처진 행)는 replan 시
    // api까지 끌어올린다 — 표시값을 api 아래로 두는 건 사용자가 보는 절대
    // 거짓이라 한 번에 따라잡는 게 맞다.
    const storedDisplay = display?.display_subscriber_count ?? api;
    const currentDisplay = Math.max(storedDisplay, api);

    const milestones = selectMilestones.all(channelId, cutoff) as MilestoneRow[];
    const delta = computeExpectedDailyDelta(milestones, { now, halfLifeDays: halfLife });
    const expectedDailyDelta = delta?.expectedDailyDelta ?? getFallbackDailyDelta(api);

    const { target, todayDelta } = computeTargetAndDelta({
      display: currentDisplay,
      api,
      cap,
      expectedDailyDelta,
    });

    const tier = decideTier(rank, displayLimit, bufferSize);
    const stepBounds = getStepBounds(api);
    const changeCount = decideChangeCount({ todayDelta, stepBounds, tier });

    const firstIntervalMs = pickFirstIntervalMs({
      remainingMs,
      remainingChanges: changeCount,
      jitterRatio,
    });
    const nextChangeAt = new Date(now.getTime() + firstIntervalMs).toISOString();

    // created_at은 INSERT 경로에서만 박힘 (ON CONFLICT DO UPDATE는 무시).
    // 기존 행은 자신의 created_at 유지.
    upsert.run(
      channelId,
      currentDisplay,
      target,
      cap,
      todayDelta,
      changeCount,
      nextChangeAt,
      jstToday,
      nowIso, // last_planned_at
      nowIso, // updated_at
      nowIso, // created_at (INSERT만 적용)
    );
    stats.planned++;
  }

  return stats;
}
