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
  SMALL_ABSNET_THRESHOLD,
  type ScheduledEvent,
} from './schedule';

// 사전 스케줄 planner의 순수 결정부 (DB 접근 없음 → 단위 테스트 가능).
// worker/display-planner.ts가 이걸 조립해 한 채널의 사이클 계획을 만든다.

export interface PlanConfig {
  minMilestones: number;          // 마일스톤 ↓ → fixed phase
  maxMagnitude: number;            // catch-up phase 이벤트당 절대 상한 (보통 40)
  catchUpIntervalMs: number;       // catch-up 이벤트 간격 (보통 5000)
  normalMaxMagnitude: number;      // normal/bounce phase 이벤트당 절대 상한 (보통 10)
  cycleMs: number;                 // 사이클 길이 (1시간)
  targetRatio: number;             // target = latest + ratio×(latest−prev), 보통 0.95
  bounceStepRatio: number;         // bounce 진동 진폭 = bucket unit × ratio
  paceMaxIntervals: number;        // predictedHours 가중평균에 사용할 최근 간격 수
  jitterRatio: number;             // 시각 jitter 비율 (0~1)
  bounceCount: number;             // target-bounce phase 이벤트 개수 (보통 N_MAX_RANGE 근처)
  trendMaxIntervals: number;       // trendSign 가중합에 사용할 최근 transition 최대 수
  trendEpsilon: number;            // |가중합| ≤ ε이면 trendSign=0 (정체)으로 흡수
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
// scheduler)가 발동. 현재 화면 display값에서 target까지 catchUpIntervalMs(=5초)
// 고정 간격, 이벤트당 최대 ±maxMagnitude(=40)로 단방향 진행.
//
// 사이클(=1시간)에 묶이지 않는다. 갭이 크면 총 소요 시간이 1시간을 넘는다 —
// 큰 채널이 1시간 안에 다 닫으려고 1초당 1회씩 폭주하던 문제를 막기 위함
// (2026-06-08 customer feedback).
//   target: milestone 트리거에선 새 api값. 2026-06-11 CF-17: planTargetCycle
//           내부에서도 "마일스톤 + bucket×1%"까지 끌어올릴 때 재사용 가능하게
//           시그니처 일반화(원래 이름은 api였음).
//   currentDisplay: display_state.display_subscriber_count (이미 있는 화면 값)
//                   None이면 첫 시드 → display=target으로 두고 빈 스케줄.
export function planCatchUp(
  target: number,
  currentDisplay: number | null,
  cfg: PlanConfig,
  rng?: () => number,
): CyclePlan {
  if (currentDisplay === null) {
    return { phase: 'catch-up', display: target, target, netDelta: 0, events: [] };
  }
  const netDelta = target - currentDisplay;
  if (netDelta === 0) {
    return { phase: 'catch-up', display: currentDisplay, target, netDelta: 0, events: [] };
  }
  const events = buildCatchUpEvents({
    netDelta,
    intervalMs: cfg.catchUpIntervalMs,
    maxMagnitude: cfg.maxMagnitude,
    rng,
  });
  return { phase: 'catch-up', display: currentDisplay, target, netDelta, events };
}

// target 플랜 — 사이클 만료 트리거에서 호출. 마일스톤 추세 따라 target 향해
// 이동하거나(normal), target에서 진동(target-bounce). 마일스톤 부족이면 fixed.
//
// 2026-06-09 CF-8 재설계: 활동성 곡선(computeActivityN) 폐기. buildCycleEvents가
// absNet 기반으로 N(이벤트 개수)을 직접 결정 + 빈 슬롯 회피 분기 내장.
// planTargetCycle은 absNet과 trendDir만 전달.
//
// 중요: display !== api여도 catch-up으로 전환하지 않는다. catch-up은 별도
// 함수(planCatchUp)이고, 호출자가 마일스톤 점프 트리거일 때만 부른다.
//   storedDisplay: display_state.display_subscriber_count (없으면 api로 시드)
export function planTargetCycle(
  api: number,
  storedDisplay: number | null,
  milestones: MilestoneRow[],
  cfg: PlanConfig,
  now: Date,
  rng?: () => number,
): CyclePlan {
  // fixed: 마일스톤 부족(cfg.minMilestones 미만) → api값 고정 표시, 스케줄 없음.
  if (milestones.length < cfg.minMilestones) {
    return { phase: 'fixed', display: api, target: api, netDelta: 0, events: [] };
  }

  const display = storedDisplay ?? api;
  const cycleHours = cfg.cycleMs / 3_600_000;
  const targetInfo = computeMilestoneTarget(milestones, cfg.targetRatio, {
    maxIntervals: cfg.trendMaxIntervals,
    epsilon: cfg.trendEpsilon,
  })!;

  // 마일스톤 직후 시각 도달 신호용 catch-up 목표(2026-06-11 CF-17).
  // 적응 분배(=작은 absNet)로 한 사이클이 시작될 때 화면이 마일스톤 근처에
  // 머무르면 50:50 진동으로 보이는 문제를 막는다. "마일스톤 + 자릿값의 1%"까지
  // catch-up(=5초 페이스, 단방향)으로 빠르게 올라간 뒤 다음 사이클부터 적응
  // 분배가 그 자리에서 잔잔히 흔든다.
  //
  // 자릿값(api-bucket.unit) — YouTube가 구독자 수를 반올림하는 단위 그 자체:
  //   <10M 채널 → 10,000  → 1% = 100
  //   <100M     → 100,000 → 1% = 1,000
  //   ≥100M     → 1,000,000 → 1% = 10,000
  const bucketUnit = getApiBucket(api).unit;
  const milestoneAbove = Math.max(1, Math.round(bucketUnit * 0.01));
  const milestoneCatchUpTarget = targetInfo.latest + milestoneAbove;

  // 감소·정체 채널 정책(2026-06-10): 다음 마일스톤을 예측하지 않는다.
  //   - display ≥ latest: 현재 자리에서 ±amplitude 진동. 단 누적이 latest 밑으로는
  //     못 가게 negCap 보호. display가 마일스톤보다 한참 위에 떠 있어도 끌어내리지
  //     않고 거기서 잔잔히 머문다 — "대기하다가 다음 마일스톤이 올라오면 따라간다".
  //   - display < latest: 정체(0)는 catch-up으로 milestoneCatchUpTarget까지 빠르게,
  //     감소(-1)는 normal phase로 effectiveTarget(=latest+amp)까지 위로 이동.
  // 양방향 진동이 floor를 깨던 문제 + 정체 채널을 강제 하락시키던 문제 동시 차단.
  if (targetInfo.trendSign !== 1) {
    const amplitude = Math.max(1, Math.round(cfg.bounceStepRatio * bucketUnit));
    const floor = targetInfo.latest;
    const offset = display - floor;

    if (offset >= 0) {
      // 누적 pos는 [-min(amp, offset), +amp] 범위 = display가 latest 밑으로 못 감.
      const negCap = Math.min(amplitude, offset);
      const events = buildBounceEvents({
        amplitude,
        count: cfg.bounceCount,
        cycleMs: cfg.cycleMs,
        jitterRatio: cfg.jitterRatio,
        rng,
        posCap: amplitude,
        negCap,
        startPos: 0,
      });
      return { phase: 'target-bounce', display, target: display, netDelta: 0, events };
    }

    // display < latest. 정체(0)는 마일스톤+1%까지 catch-up으로 빠르게.
    // 감소(-1)는 마일스톤 위쪽(=latest+amp)까지 1시간 분산(normal).
    if (targetInfo.trendSign === 0) {
      return planCatchUp(milestoneCatchUpTarget, display, cfg, rng);
    }

    const effectiveTarget = floor + amplitude;
    const full = effectiveTarget - display;
    const events = buildCycleEvents({
      netDelta: full,
      cycleMs: cfg.cycleMs,
      maxMagnitude: cfg.normalMaxMagnitude,
      jitterRatio: cfg.jitterRatio,
      rng,
    });
    const actualNetDelta = events.reduce((s, e) => s + e.magnitude, 0);
    return { phase: 'normal', display, target: effectiveTarget, netDelta: actualNetDelta, events };
  }

  const target = targetInfo.target;

  const predictedHours = computePredictedHoursToNextMilestone(milestones, {
    maxIntervals: cfg.paceMaxIntervals,
    now,
  });

  const full = target - display;
  let netDelta = 0;
  // 위 분기에서 trendSign !== 1을 모두 잡아냈으므로 여기 도달 시 trendSign === 1.
  if (predictedHours && full !== 0) {
    const raw = full * (cycleHours / predictedHours);
    // target 추월 금지: 한 사이클 이동량이 남은 거리를 넘으면 남은 거리로 클램프.
    netDelta = Math.abs(raw) >= Math.abs(full) ? full : Math.round(raw);
  }

  if (netDelta === 0) {
    // target-bounce: ±bounceStepRatio × bucket unit 진동, net ≈ 0.
    const amplitude = Math.max(1, Math.round(cfg.bounceStepRatio * bucketUnit));
    const events = buildBounceEvents({
      amplitude,
      count: cfg.bounceCount,
      cycleMs: cfg.cycleMs,
      jitterRatio: cfg.jitterRatio,
      rng,
    });
    return { phase: 'target-bounce', display, target, netDelta: 0, events };
  }

  // 마일스톤 도달 catch-up(2026-06-11 CF-17): 이번 사이클이 적응 분배 영역
  // (|netDelta| < SMALL_ABSNET_THRESHOLD)이고 화면이 아직 마일스톤+1% 미만이면,
  // 1시간에 분산하지 않고 5초 페이스로 그 지점까지 끌어올린다. 마일스톤 직후의
  // 시각 도달을 또렷이 보여주고, 그 위에서 다음 사이클이 적응 분배로 흔든다.
  if (Math.abs(netDelta) < SMALL_ABSNET_THRESHOLD && display < milestoneCatchUpTarget) {
    return planCatchUp(milestoneCatchUpTarget, display, cfg, rng);
  }

  const events = buildCycleEvents({
    netDelta,
    cycleMs: cfg.cycleMs,
    maxMagnitude: cfg.normalMaxMagnitude,
    jitterRatio: cfg.jitterRatio,
    rng,
  });
  // buildCycleEvents의 적응 분배는 P-Q 정수 보정으로 ±1 오차 가능. 실제 적용분은
  // 이벤트 합과 일치 — display_state.today_delta가 진짜 적용분을 가리키게 한다.
  const actualNetDelta = events.reduce((s, e) => s + e.magnitude, 0);
  return { phase: 'normal', display, target, netDelta: actualNetDelta, events };
}
