import { describe, it, expect } from 'vitest';
import {
  planCatchUp,
  planTargetCycle,
  computeActivityN,
  computeDynamicCounterRatio,
  type PlanConfig,
} from './schedule-plan';
import type { MilestoneRow } from './milestone-delta';

const HOUR = 3_600_000;
const BASE = Date.parse('2026-06-06T00:00:00.000Z');

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

// hours: 각 행의 시각(시간), counts: 구독자 수. 같은 길이.
function milestones(hours: number[], counts: number[]): MilestoneRow[] {
  return hours.map((h, i) => ({
    polled_at: new Date(BASE + h * HOUR).toISOString(),
    subscriber_count: counts[i]!,
  }));
}

const cfg: PlanConfig = {
  minMilestones: 3,
  minEvents: 6,
  maxMagnitude: 40,
  normalMaxMagnitude: 10,
  counterRatio: 0.2,
  cycleMs: HOUR,
  catchUpIntervalMs: 3_000,
  targetRatio: 0.95,
  bounceStepRatio: 0.03,
  paceMaxIntervals: 8,
  jitterRatio: 0.5,
  activityNMin: 40,
  activityNMax: 100,
  activityPivot: 300,
};

const sum = (es: { magnitude: number }[]) => es.reduce((a, e) => a + e.magnitude, 0);

describe('planCatchUp', () => {
  it('상향 catch-up: 3초 간격·이벤트당 최대 40으로 단방향 분배', () => {
    const api = 5_000_000;
    const plan = planCatchUp(api, api - 50, cfg, lcg(2));
    expect(plan.phase).toBe('catch-up');
    expect(plan.display).toBe(api - 50); // 현재 화면값 유지(시작점)
    expect(plan.target).toBe(api);
    expect(plan.netDelta).toBe(50);
    expect(sum(plan.events)).toBe(50);
    expect(plan.events.every((e) => e.magnitude > 0)).toBe(true);
    expect(plan.events.every((e) => e.magnitude <= 40)).toBe(true);
    // 3초 고정 간격 — i × 3000.
    plan.events.forEach((e, i) => expect(e.offsetMs).toBe(i * 3_000));
  });

  it('하향 catch-up: api가 폴링에서 줄었을 때도 동일하게 단방향', () => {
    const api = 5_000_000;
    const plan = planCatchUp(api, api + 30, cfg, lcg(3));
    expect(plan.phase).toBe('catch-up');
    expect(plan.netDelta).toBe(-30);
    expect(sum(plan.events)).toBe(-30);
    expect(plan.events.every((e) => e.magnitude < 0)).toBe(true);
    plan.events.forEach((e, i) => expect(e.offsetMs).toBe(i * 3_000));
  });

  it('큰 갭: 사이클(1h)에 묶이지 않고 매그니튜드 다양', () => {
    // 다양화: T≈1786 trend + C≈94 counter → N≈1880. 합 = absNet.
    const api = 5_000_000;
    const plan = planCatchUp(api, api - 50_000, cfg, lcg(7));
    expect(plan.events.length).toBeGreaterThanOrEqual(1_780);
    expect(plan.events.length).toBeLessThanOrEqual(1_950);
    expect(sum(plan.events)).toBe(50_000);
    const last = plan.events[plan.events.length - 1]!;
    expect(last.offsetMs).toBeGreaterThan(HOUR); // 사이클(1h) 초과 — 의도된 동작
  });

  it('신규 시드(currentDisplay=null) → display=api, 빈 스케줄', () => {
    const plan = planCatchUp(5_000_000, null, cfg, lcg(4));
    expect(plan.phase).toBe('catch-up');
    expect(plan.display).toBe(5_000_000);
    expect(plan.netDelta).toBe(0);
    expect(plan.events).toHaveLength(0);
  });

  it('이미 도달(display == api) → 빈 스케줄, display 유지', () => {
    const plan = planCatchUp(5_000_000, 5_000_000, cfg, lcg(5));
    expect(plan.netDelta).toBe(0);
    expect(plan.events).toHaveLength(0);
  });
});

describe('planTargetCycle', () => {
  it('fixed: 마일스톤 < minMilestones → api 고정, 스케줄 없음', () => {
    const ms = milestones([0, 1], [4_995_000, 5_000_000]); // 2개 < 3
    const plan = planTargetCycle(5_000_000, 4_900_000, ms, cfg, lcg(1));
    expect(plan.phase).toBe('fixed');
    expect(plan.display).toBe(5_000_000); // api값으로 고정
    expect(plan.target).toBe(5_000_000);
    expect(plan.events).toHaveLength(0);
  });

  it('normal: display == api → target 향해 시간당 목표만큼, pace로 나눔', () => {
    // step=100, 1시간 간격 → target = 5_000_000 + 0.95×100 = 5_000_095, full=95
    // predictedHours=1 → netDelta = 95 × (1/1) = 95
    const counts = [4_999_500, 4_999_600, 4_999_700, 4_999_800, 4_999_900, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, lcg(3));
    expect(plan.phase).toBe('normal');
    expect(plan.target).toBe(5_000_095);
    expect(plan.netDelta).toBe(95);
    expect(sum(plan.events)).toBe(95);
    // 동적 counterRatio (absNet 작아 ~0.5) → 감소 이벤트 다수 섞임
    expect(plan.events.some((e) => e.magnitude < 0)).toBe(true);
    expect(plan.events.every((e) => Math.abs(e.magnitude) <= 20)).toBe(true);
  });

  it('target-bounce: 추세 0(정체) → net 0 진동, ±3% bucket unit', () => {
    const flat = Array(6).fill(5_000_000);
    const ms = milestones([0, 1, 2, 3, 4, 5], flat);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, lcg(4));
    expect(plan.phase).toBe('target-bounce');
    expect(plan.netDelta).toBe(0);
    expect(sum(plan.events)).toBe(0);
    // unit(5M → 10,000) × 0.03 = 300
    expect(plan.events.some((e) => e.magnitude === 300)).toBe(true);
    expect(plan.events.some((e) => e.magnitude === -300)).toBe(true);
  });

  it('하락 추세 normal: netDelta 음수, 이벤트 합 일치', () => {
    // step=-100, 1시간 간격 → target = 5_000_000 + 0.95×(-100) = 4_999_905
    const counts = [5_000_500, 5_000_400, 5_000_300, 5_000_200, 5_000_100, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, lcg(5));
    expect(plan.phase).toBe('normal');
    expect(plan.target).toBe(4_999_905);
    expect(plan.netDelta).toBeLessThan(0);
    expect(sum(plan.events)).toBe(plan.netDelta);
  });

  // 활동성 곡선(2026-06-08): 하위 채널 정체 해소 검증.
  it('하위 채널(작은 absNet) → 이벤트 수 N_MAX 근처 + 감소 비율 ↑', () => {
    // step=10, 1시간 간격 → target=5_000_000+0.95×10=5_000_010(round 9), netDelta ≈ 9~10
    const counts = [4_999_950, 4_999_960, 4_999_970, 4_999_980, 4_999_990, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, lcg(11));
    expect(plan.phase).toBe('normal');
    expect(Math.abs(plan.netDelta)).toBeLessThanOrEqual(15);
    // N_MAX=100, absNet≈10 → N≈89. 50개 이상은 보장.
    expect(plan.events.length).toBeGreaterThan(60);
    const negCount = plan.events.filter((e) => e.magnitude < 0).length;
    // counter slot 비율 ~0.49 → 감소 이벤트 40% 이상
    expect(negCount / plan.events.length).toBeGreaterThan(0.4);
  });

  // 회귀 검증 (2026-06-08): 사용자 피드백 #2.
  // 정상 운영 결과로 display가 api 위로 살짝 떠 있을 때, 사이클 만료 트리거가
  // 이걸 깎아내리지 않는다. display != api라는 이유만으로 catch-up downward를
  // 발동시키던 과거 동작에 대한 회귀.
  it('회귀: display > api여도 catch-up으로 깎지 않음 (target 플랜만 적용)', () => {
    // 마일스톤 12개 모두 같은 값 — trendSign=0 → target-bounce 직행.
    const flat = Array(12).fill(5_000_000);
    const ms = milestones(Array.from({ length: 12 }, (_, i) => i), flat);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api + 39, ms, cfg, lcg(99));
    expect(plan.phase).toBe('target-bounce');
    expect(plan.display).toBe(api + 39); // 떠 있는 display 그대로
    expect(plan.netDelta).toBe(0);       // 음수 깎기 없음
    expect(sum(plan.events)).toBe(0);
  });
});

describe('computeActivityN', () => {
  const c = { ...cfg };
  it('absNet=0 → N_MAX', () => expect(computeActivityN(0, c)).toBe(100));
  it('absNet ≥ pivot → N_MIN', () => {
    expect(computeActivityN(300, c)).toBe(40);
    expect(computeActivityN(1_000, c)).toBe(40);
    expect(computeActivityN(10_000, c)).toBe(40);
  });
  it('제곱근 곡선: 하위 구간이 가파르게 N_MAX 근처', () => {
    expect(computeActivityN(10, c)).toBeGreaterThan(80);
    const n50 = computeActivityN(50, c);
    expect(n50).toBeGreaterThan(60);
    expect(n50).toBeLessThan(85);
    expect(computeActivityN(200, c)).toBeLessThan(60);
  });
});

describe('computeDynamicCounterRatio', () => {
  it('absNet 작음 → counter slot이 N의 절반에 클램프', () => {
    // N=89, absNet=10 → nTrendMin=1, slots=min(88, 44)=44 → ratio=44/89
    expect(computeDynamicCounterRatio(10, 89, 20)).toBeCloseTo(44 / 89, 3);
    expect(computeDynamicCounterRatio(10, 89, 20)).toBeLessThanOrEqual(0.5);
  });
  it('absNet이 N×maxMag을 초과 → counter 0 (catch-up 전량 추세)', () => {
    // N=40, absNet=5000 → nTrendMin=250 > N → slots=0
    expect(computeDynamicCounterRatio(5_000, 40, 20)).toBe(0);
  });
});
