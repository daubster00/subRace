import { getApiBucket } from './api-bucket';
import {
  computeMilestoneTarget,
  computePredictedHoursToNextMilestone,
  type MilestoneRow,
} from './milestone-delta';
import {
  buildBounceEvents,
  buildCatchUpEvents,
  buildCycleEvents,
  type ScheduledEvent,
} from './schedule';

// 사전 스케줄 planner의 순수 결정부 (DB 접근 없음 → 단위 테스트 가능).
// worker/display-planner.ts가 이걸 조립해 한 채널의 사이클 계획을 만든다.

export interface PlanConfig {
  minMilestones: number;
  // DEPRECATED (2026-06-08): activity* 곡선이 대체. 코드는 더 이상 참조하지 않지만
  // env→cfg 어댑터가 같은 객체를 넘기므로 타입에 남김.
  minEvents: number;
  // catch-up phase 전용 이벤트당 절대 상한. 큰 갭은 한 사이클이 아니라 N×interval
  // 시간만큼 늘려 따라잡는다 — 1초당 1회식 폭주를 막기 위해 normal보다 크게 잡되
  // 이벤트 간격을 catchUpIntervalMs로 고정 (2026-06-08 customer feedback).
  maxMagnitude: number;
  // catch-up 이벤트 사이 고정 간격 (ms). 기본 3000. 사이클(cycleMs)에 묶이지 않고
  // N개 이벤트가 i × intervalMs 시각에 박힌다.
  catchUpIntervalMs: number;
  // normal/target-bounce phase 이벤트당 절대 상한 (2026-06-08, customer feedback).
  // 큰 채널이 normal phase에서 한 번에 큰 값으로 점프하면 간격이 멀어져 오히려
  // 정체로 보이는 문제 → maxMagnitude(catch-up용)보다 작게 잡아 잦은 소액 변화
  // 위주로 분배.
  normalMaxMagnitude: number;
  // DEPRECATED (2026-06-08): planTargetCycle 내부에서 absNet별 동적 산출.
  counterRatio: number;
  cycleMs: number;
  targetRatio: number;
  bounceStepRatio: number;
  paceMaxIntervals: number;
  jitterRatio: number;
  // 활동성 곡선 (2026-06-08, customer feedback). 51~100위 채널의 정체 해소.
  // absNet 0 → activityNMax, absNet ≥ activityPivot → activityNMin.
  // 사이는 제곱근으로 감소 → 하위 구간에서 활동성이 가파르게 상승.
  activityNMin: number;
  activityNMax: number;
  activityPivot: number;
}

// absNet 기반 시간당 이벤트 수 N 산출.
//   N = N_min + (N_max - N_min) × (1 - sqrt(min(1, absNet / pivot)))
// pivot 이상은 N_min에 수렴 — 상위 채널은 absNet이 알아서 추세 슬롯을 채우므로
// 굳이 N을 더 키울 필요 없음(buildCycleEvents가 ceil(absNet/maxMag)로 보강).
export function computeActivityN(absNet: number, cfg: PlanConfig): number {
  const r = Math.min(1, Math.max(0, absNet) / cfg.activityPivot);
  const raw = cfg.activityNMin + (cfg.activityNMax - cfg.activityNMin) * (1 - Math.sqrt(r));
  return Math.max(cfg.activityNMin, Math.round(raw));
}

// 동적 counterRatio: N개 슬롯 중 trend가 absNet 소화에 필요한 최소량을 빼고
// 나머지를 counter에 배정. 단 counter는 N의 절반을 넘지 않음(시각적 균형 —
// counter가 trend보다 많아지면 추세 방향이 묻혀 보임).
export function computeDynamicCounterRatio(
  absNet: number,
  N: number,
  maxMagnitude: number,
): number {
  if (N <= 0) return 0;
  const nTrendMin = Math.max(1, Math.ceil(absNet / maxMagnitude));
  const counterSlots = Math.max(0, Math.min(N - nTrendMin, Math.floor(N / 2)));
  return counterSlots / N;
}

export type Phase = 'fixed' | 'catch-up' | 'normal' | 'target-bounce';

export interface CyclePlan {
  phase: Phase;
  display: number;          // 이 사이클 시작 표시값 (display_state에 저장)
  target: number;           // display_state.target_subscriber_count
  netDelta: number;         // 사이클 순변화 (관측용; bounce는 0)
  events: ScheduledEvent[]; // fixed는 빈 배열
}

// catch-up 플랜 — YouTube API가 새 마일스톤으로 점프했을 때 호출자(channel-
// scheduler)가 발동. 현재 화면 display값에서 새 api까지 catchUpIntervalMs(=3초)
// 고정 간격, 이벤트당 최대 ±maxMagnitude(=40)로 단방향 진행.
//
// 사이클(=1시간)에 묶이지 않는다. 갭이 크면 총 소요 시간이 1시간을 넘는다 —
// 큰 채널이 1시간 안에 다 닫으려고 1초당 1회씩 폭주하던 문제를 막기 위함
// (2026-06-08 customer feedback).
//   currentDisplay: display_state.display_subscriber_count (이미 있는 화면 값)
//                   None이면 첫 시드 → display=api로 두고 빈 스케줄.
export function planCatchUp(
  api: number,
  currentDisplay: number | null,
  cfg: PlanConfig,
  rng?: () => number,
): CyclePlan {
  // 신규 시드: 화면 값 없음 → api로 바로 표시, 따라잡을 거리 없음.
  if (currentDisplay === null) {
    return { phase: 'catch-up', display: api, target: api, netDelta: 0, events: [] };
  }
  const netDelta = api - currentDisplay;
  // 차이 0이면(이미 api에 도달) catch-up 의미 없음. display 유지, 빈 스케줄.
  // 다음 사이클 만료 트리거가 target 플랜으로 자연스럽게 인계.
  if (netDelta === 0) {
    return { phase: 'catch-up', display: currentDisplay, target: api, netDelta: 0, events: [] };
  }
  const events = buildCatchUpEvents({
    netDelta,
    intervalMs: cfg.catchUpIntervalMs,
    maxMagnitude: cfg.maxMagnitude,
    rng,
  });
  return { phase: 'catch-up', display: currentDisplay, target: api, netDelta, events };
}

// target 플랜 — 사이클 만료 트리거에서 호출. 마일스톤 추세 따라 target 향해
// 이동하거나(normal), target에서 진동(target-bounce). 마일스톤 부족이면 fixed.
//
// 중요: display !== api여도 catch-up으로 전환하지 않는다. catch-up은 별도
// 함수(planCatchUp)이고, 호출자가 마일스톤 점프 트리거일 때만 부른다. 정상
// 운영 중 display가 api 위로 살짝 떠 있는 상태(이전 사이클 normal의 결과)는
// 여기서 target 향한 다음 이동의 시작점일 뿐 — 깎아내리지 않는다.
//   storedDisplay: display_state.display_subscriber_count (없으면 api로 시드)
export function planTargetCycle(
  api: number,
  storedDisplay: number | null,
  milestones: MilestoneRow[],
  cfg: PlanConfig,
  rng?: () => number,
): CyclePlan {
  // fixed: 마일스톤 부족(cfg.minMilestones 미만) → api값 고정 표시, 스케줄 없음.
  // 사이클 만료 트리거 전용 분기다. 새 마일스톤 trigger는 planCatchUp을 거치므로
  // fixed 채널이라도 폴링으로 api가 변하면 catch-up phase로 자동 전환된다.
  if (milestones.length < cfg.minMilestones) {
    return { phase: 'fixed', display: api, target: api, netDelta: 0, events: [] };
  }

  const display = storedDisplay ?? api;
  const cycleHours = cfg.cycleMs / 3_600_000;
  const targetInfo = computeMilestoneTarget(milestones, cfg.targetRatio)!;
  const target = targetInfo.target;

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
    // target-bounce: ±3% of bucket unit 진동, net 0. 진동 횟수도 활동성 곡선의
    // 최대값(absNet=0 → N_MAX)을 그대로 — 정체 채널일수록 더 자주 흔들림.
    const amplitude = Math.max(1, Math.round(cfg.bounceStepRatio * getApiBucket(api).unit));
    const N = computeActivityN(0, cfg);
    const events = buildBounceEvents({
      amplitude,
      count: N,
      cycleMs: cfg.cycleMs,
      jitterRatio: cfg.jitterRatio,
      rng,
    });
    return { phase: 'target-bounce', display, target, netDelta: 0, events };
  }

  const absNet = Math.abs(netDelta);
  const N = computeActivityN(absNet, cfg);
  const dynamicCounterRatio = computeDynamicCounterRatio(absNet, N, cfg.normalMaxMagnitude);
  const events = buildCycleEvents({
    netDelta,
    cycleMs: cfg.cycleMs,
    minEvents: N,
    maxMagnitude: cfg.normalMaxMagnitude,
    counterRatio: dynamicCounterRatio,
    jitterRatio: cfg.jitterRatio,
    rng,
  });
  return { phase: 'normal', display, target, netDelta, events };
}
