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
  minMilestones: number;          // 마일스톤 ↓ → fixed phase
  maxMagnitude: number;            // catch-up phase 이벤트당 절대 상한 (보통 40)
  catchUpIntervalMs: number;       // catch-up 이벤트 간격 (보통 5000)
  normalMaxMagnitude: number;      // normal/bounce phase 이벤트당 절대 상한 (보통 10)
  cycleMs: number;                 // 사이클 길이 (1시간)
  targetRatio: number;             // 상승 천장(주차) = latest + ratio×한 단위, 보통 0.99
  baseSpeedRatio: number;          // 상승 기본 속도 = ratio × 예상속도, 보통 0.9
  parkBounceRatio: number;         // 99% 주차 후 미세 진동 폭 = ratio × 한 단위, 보통 0.002
  bounceStepRatio: number;         // 하락·정체 밴드 폭 = bucket unit × ratio (1%)
  paceMaxIntervals: number;        // predictedHours 가중평균에 사용할 최근 간격 수
  jitterRatio: number;             // 시각 jitter 비율 (0~1)
  bounceCount: number;             // target-bounce phase 이벤트 개수 (보통 N_MAX_RANGE 근처)
  trendMaxIntervals: number;       // trendSign 가중합에 사용할 최근 transition 최대 수
  trendEpsilon: number;            // |가중합| ≤ ε이면 trendSign=0 (정체)으로 흡수
}

export type Phase = 'fixed' | 'catch-up' | 'normal' | 'target-bounce';

// 상승 감속 곡선 (2026-06-18 고객 요청). 한 칸 구간 [마일스톤 → 다음 마일스톤]
// 안에서 화면값 위치 비율 p에 따라 기본 속도(예상속도×0.9)에 곱하는 배수.
//   p < 0.90        → 1.0  (그대로 0.9배 속도)
//   0.90 ≤ p < 0.93 → 0.5
//   0.93 ≤ p < 0.97 → 0.25
//   0.97 ≤ p < 0.99 → 0.1
//   p ≥ 0.99        → 0    (주차 — target-bounce 미세 진동, 다음 마일스톤 추월 금지)
// 배수 값은 출발안. 적용 후 화면 보고 튜닝(이 표만 고치면 됨).
const DECEL_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0.99, 0],
  [0.97, 0.1],
  [0.93, 0.25],
  [0.90, 0.5],
];

function decelFactor(p: number): number {
  for (const [threshold, factor] of DECEL_BANDS) {
    if (p >= threshold) return factor;
  }
  return 1;
}

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

  // 감소·정체 채널 정책: 화면값이 밴드 [마일스톤, 마일스톤+1%] 안에 머물게 한다.
  // 다음 마일스톤을 멀리 예측하지 않고, 마일스톤 바로 위 1%에 붙어 있는 게 정상.
  //   - display > 마일스톤+1%: normal phase로 마일스톤+1%까지 부드럽게 끌어내림.
  //     (2026-06-18 고객 정정: 하락이 시작된 채널이 옛 높은 값에 묶여 있던 버그.
  //      예전엔 "끌어내리지 않고 머문다"였으나, 하락 채널은 마일스톤이 위로 안
  //      올라오므로 영영 안 따라잡혀 정정. 원래 설계 의도 = 1% 위까지 하락.)
  //   - display ∈ [마일스톤, 마일스톤+1%]: 그 안에서 단방향 진동(아래로 못 감).
  //   - display < 마일스톤: 정체(0)는 catch-up으로 마일스톤+1%까지 빠르게,
  //     감소(-1)는 normal phase로 마일스톤+1%까지 위로 이동.
  if (targetInfo.trendSign !== 1) {
    const amplitude = Math.max(1, Math.round(cfg.bounceStepRatio * bucketUnit));
    const floor = targetInfo.latest;
    const ceiling = floor + amplitude;
    const offset = display - floor;

    // display가 밴드 위로 떠 있으면 → 마일스톤+1%로 끌어내림. buildCycleEvents가
    // 사이클당 안전 상한(이벤트당 ≤30)으로 나눠 내리므로 한 번에 뚝 안 떨어지고,
    // 갭이 크면(예: 상승하다 막 꺾인 채널) 다음 사이클에 이어서 내려간다.
    if (display > ceiling) {
      const full = ceiling - display; // 음수
      const events = buildCycleEvents({
        netDelta: full,
        cycleMs: cfg.cycleMs,
        maxMagnitude: cfg.normalMaxMagnitude,
        jitterRatio: cfg.jitterRatio,
        rng,
      });
      const actualNetDelta = events.reduce((s, e) => s + e.magnitude, 0);
      return { phase: 'normal', display, target: ceiling, netDelta: actualNetDelta, events };
    }

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
    // 감소(-1)는 마일스톤 위쪽(=ceiling=마일스톤+1%)까지 1시간 분산(normal).
    if (targetInfo.trendSign === 0) {
      return planCatchUp(milestoneCatchUpTarget, display, cfg, rng);
    }

    const full = ceiling - display;
    const events = buildCycleEvents({
      netDelta: full,
      cycleMs: cfg.cycleMs,
      maxMagnitude: cfg.normalMaxMagnitude,
      jitterRatio: cfg.jitterRatio,
      rng,
    });
    const actualNetDelta = events.reduce((s, e) => s + e.magnitude, 0);
    return { phase: 'normal', display, target: ceiling, netDelta: actualNetDelta, events };
  }

  // ── 상승 채널 (trendSign === 1) — 0.9배 속도 + 단계 감속 곡선 (2026-06-18) ──
  // 한 칸 구간 [floor=마일스톤, ceiling=마일스톤+0.99단위] 안에서, 화면값 위치
  // 비율 p에 따라 기본 속도(예상속도×baseSpeedRatio)에 감속 배수를 곱해 이동한다.
  // p가 0.90을 넘으면 단계적으로 느려지고 0.99(=ceiling)에 주차해 다음 마일스톤을
  // 절대 추월하지 않는다. 마일스톤이 API로 확정되면 floor가 한 칸 위로 점프하여
  // 화면값이 새 칸으로 자연스럽게 이어 오른다(상승 catch-up 불필요).
  const floor = targetInfo.latest;
  const ceiling = floor + Math.round(cfg.targetRatio * bucketUnit); // 0.99 단위

  // 화면값이 천장 위로 떠 있으면 → 천장으로 끌어내림(하락 분기와 대칭). 이전 상태
  // 잔재나 천장 하향 변동(추세·마일스톤 변화)으로 위에 남은 경우를 분산 이동으로
  // 정리한다. 주차 진동(±parkBounce)만으로는 너무 느려 여기서 먼저 내린다.
  if (display > ceiling) {
    const events = buildCycleEvents({
      netDelta: ceiling - display, // 음수
      cycleMs: cfg.cycleMs,
      maxMagnitude: cfg.normalMaxMagnitude,
      jitterRatio: cfg.jitterRatio,
      rng,
    });
    const actualNetDelta = events.reduce((s, e) => s + e.magnitude, 0);
    return { phase: 'normal', display, target: ceiling, netDelta: actualNetDelta, events };
  }

  const predictedHours = computePredictedHoursToNextMilestone(milestones, {
    maxIntervals: cfg.paceMaxIntervals,
    now,
  });

  let netDelta = 0;
  if (predictedHours && display < ceiling) {
    const p = (display - floor) / bucketUnit; // 한 칸 안 위치 비율
    // 기본 이동 = baseSpeedRatio × 예상속도 × 사이클시간
    //   예상속도(=한 단위 / 예상 도달시간) × 사이클시간 = 단위 × (사이클시간/예상시간)
    const baseMove = cfg.baseSpeedRatio * bucketUnit * (cycleHours / predictedHours);
    netDelta = Math.round(baseMove * decelFactor(p));
    // 천장 추월 금지: 이동 후 ceiling을 넘으면 남은 거리로 클램프.
    if (display + netDelta > ceiling) netDelta = ceiling - display;
    if (netDelta < 0) netDelta = 0;
  }

  if (netDelta === 0) {
    // 99% 주차 → 천장 바로 아래에서 미세 진동. posCap=천장까지 남은 여유(보통 0),
    // negCap=parkBounce 폭 → 아래로만 흔들려 다음 마일스톤을 절대 안 넘는다.
    const amplitude = Math.max(1, Math.round(cfg.parkBounceRatio * bucketUnit));
    const posCap = Math.min(amplitude, Math.max(0, ceiling - display));
    const events = buildBounceEvents({
      amplitude,
      count: cfg.bounceCount,
      cycleMs: cfg.cycleMs,
      jitterRatio: cfg.jitterRatio,
      rng,
      posCap,
      negCap: amplitude,
      startPos: 0,
    });
    return { phase: 'target-bounce', display, target: ceiling, netDelta: 0, events };
  }

  const events = buildCycleEvents({
    netDelta,
    cycleMs: cfg.cycleMs,
    maxMagnitude: cfg.normalMaxMagnitude,
    jitterRatio: cfg.jitterRatio,
    rng,
  });
  // 천장 추월 하드 가드(상승 한정): buildCycleEvents의 적응 분배는 분산이 있어
  // 작은 netDelta를 초과해 화면값을 천장 위로 밀 수 있다. 시간순 누적이 ceiling을
  // 넘는 양수 이벤트를 그만큼 깎아 다음 마일스톤을 절대 못 넘게 한다.
  let cum = display;
  for (const e of events) {
    if (e.magnitude > 0 && cum + e.magnitude > ceiling) {
      e.magnitude = Math.max(0, ceiling - cum);
    }
    cum += e.magnitude;
  }
  const guarded = events.filter((e) => e.magnitude !== 0);
  // 실제 적용분은 이벤트 합과 일치 — display_state.today_delta가 진짜 적용분을 가리킨다.
  const actualNetDelta = guarded.reduce((s, e) => s + e.magnitude, 0);
  return { phase: 'normal', display, target: ceiling, netDelta: actualNetDelta, events: guarded };
}
