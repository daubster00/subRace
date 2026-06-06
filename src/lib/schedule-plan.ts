import { getApiBucket } from './api-bucket';
import {
  computeMilestoneTarget,
  computePredictedHoursToNextMilestone,
  type MilestoneRow,
} from './milestone-delta';
import { buildCycleEvents, buildBounceEvents, type ScheduledEvent } from './schedule';

// 사전 스케줄 planner의 순수 결정부 (DB 접근 없음 → 단위 테스트 가능).
// worker/display-planner.ts가 이걸 조립해 한 채널의 사이클 계획을 만든다.

export interface PlanConfig {
  minMilestones: number;
  minEvents: number;
  maxMagnitude: number;
  counterRatio: number;
  cycleMs: number;
  targetRatio: number;
  bounceStepRatio: number;
  paceMaxIntervals: number;
  jitterRatio: number;
}

export type Phase = 'fixed' | 'catch-up' | 'normal' | 'target-bounce';

export interface CyclePlan {
  phase: Phase;
  display: number;          // 이 사이클 시작 표시값 (display_state에 저장)
  target: number;           // display_state.target_subscriber_count
  netDelta: number;         // 사이클 순변화 (관측용; bounce는 0)
  events: ScheduledEvent[]; // fixed는 빈 배열
}

// 한 채널의 사이클 계획 산출.
//   api          : poll_state.api_subscriber_count (최신 실제 구독자 수)
//   storedDisplay: display_state.display_subscriber_count (없으면 null → 신규)
//   milestones   : window 내 (polled_at, subscriber_count) 시간순
export function planChannel(
  api: number,
  storedDisplay: number | null,
  milestones: MilestoneRow[],
  cfg: PlanConfig,
  rng?: () => number,
): CyclePlan {
  // fixed: 마일스톤 부족(6개 미만) → api값 고정 표시, 스케줄 없음 (2026-06-06 결정).
  if (milestones.length < cfg.minMilestones) {
    return { phase: 'fixed', display: api, target: api, netDelta: 0, events: [] };
  }

  const display = storedDisplay ?? api;
  const cycleHours = cfg.cycleMs / 3_600_000;
  const targetInfo = computeMilestoneTarget(milestones, cfg.targetRatio)!;
  const target = targetInfo.target;

  // catch-up: 표시값이 실제 최신 마일스톤(api)에서 벗어나 있으면 1시간 안에 도달.
  // 100% 추세 방향(counterRatio 0).
  if (display !== api) {
    const netDelta = api - display;
    const events = buildCycleEvents({
      netDelta,
      cycleMs: cfg.cycleMs,
      minEvents: cfg.minEvents,
      maxMagnitude: cfg.maxMagnitude,
      counterRatio: 0,
      jitterRatio: cfg.jitterRatio,
      rng,
    });
    return { phase: 'catch-up', display, target: api, netDelta, events };
  }

  // display == api: target 향해 이동 or 진동.
  const predictedHours = computePredictedHoursToNextMilestone(milestones, {
    maxIntervals: cfg.paceMaxIntervals,
  });

  const full = target - display;
  let netDelta = 0;
  if (predictedHours && targetInfo.trendSign !== 0 && full !== 0) {
    const raw = full * (cycleHours / predictedHours);
    // target 추월 금지: 한 사이클 이동량이 남은 거리를 넘으면 남은 거리로 클램프.
    netDelta = Math.abs(raw) >= Math.abs(full) ? full : Math.round(raw);
  }

  if (netDelta === 0) {
    // target-bounce: ±3% of bucket unit 진동, net 0.
    const amplitude = Math.max(1, Math.round(cfg.bounceStepRatio * getApiBucket(api).unit));
    const events = buildBounceEvents({
      amplitude,
      count: cfg.minEvents,
      cycleMs: cfg.cycleMs,
      jitterRatio: cfg.jitterRatio,
      rng,
    });
    return { phase: 'target-bounce', display, target, netDelta: 0, events };
  }

  const events = buildCycleEvents({
    netDelta,
    cycleMs: cfg.cycleMs,
    minEvents: cfg.minEvents,
    maxMagnitude: cfg.maxMagnitude,
    counterRatio: cfg.counterRatio,
    jitterRatio: cfg.jitterRatio,
    rng,
  });
  return { phase: 'normal', display, target, netDelta, events };
}
