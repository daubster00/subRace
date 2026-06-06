import { describe, it, expect } from 'vitest';
import { planChannel, type PlanConfig } from './schedule-plan';
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
  minMilestones: 6,
  minEvents: 6,
  maxMagnitude: 20,
  counterRatio: 0.2,
  cycleMs: HOUR,
  targetRatio: 0.95,
  bounceStepRatio: 0.03,
  paceMaxIntervals: 8,
  jitterRatio: 0.5,
};

const sum = (es: { magnitude: number }[]) => es.reduce((a, e) => a + e.magnitude, 0);

describe('planChannel', () => {
  it('fixed: 마일스톤 < minMilestones → api 고정, 스케줄 없음', () => {
    const ms = milestones([0, 1, 2], [4_990_000, 4_995_000, 5_000_000]); // 3개 < 6
    const plan = planChannel(5_000_000, 4_900_000, ms, cfg, lcg(1));
    expect(plan.phase).toBe('fixed');
    expect(plan.display).toBe(5_000_000); // api값으로 고정
    expect(plan.target).toBe(5_000_000);
    expect(plan.events).toHaveLength(0);
  });

  it('catch-up: display != api → 1시간 안에 api 도달, 100% 추세 방향', () => {
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const plan = planChannel(api, api - 50, ms, cfg, lcg(2));
    expect(plan.phase).toBe('catch-up');
    expect(plan.target).toBe(api);
    expect(plan.netDelta).toBe(50);
    expect(sum(plan.events)).toBe(50);
    // catch-up은 반대 방향 0 — 모두 양수
    expect(plan.events.every((e) => e.magnitude > 0)).toBe(true);
    expect(plan.events.length).toBeGreaterThanOrEqual(6);
  });

  it('normal: display == api → target 향해 시간당 목표만큼, pace로 나눔', () => {
    // 2시간 간격 6행, +10k씩 → latest 5,000,000, prev 4,990,000
    // target = 5,000,000 + 0.95×10,000 = 5,009,500 / full = 9,500
    // predictedHours = 2 (간격 모두 2h) → netDelta = 9,500 × (1/2) = 4,750
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 2, 4, 6, 8, 10], counts);
    const api = 5_000_000;
    const plan = planChannel(api, api, ms, cfg, lcg(3));
    expect(plan.phase).toBe('normal');
    expect(plan.target).toBe(5_009_500);
    expect(plan.netDelta).toBe(4_750);
    expect(sum(plan.events)).toBe(4_750);
    // 상승 추세 normal → 반대(감소) 이벤트 일부 섞임 (80/20)
    expect(plan.events.some((e) => e.magnitude < 0)).toBe(true);
    expect(plan.events.every((e) => Math.abs(e.magnitude) <= 20)).toBe(true);
  });

  it('target-bounce: 추세 0(정체) → net 0 진동, ±3% bucket unit', () => {
    const flat = Array(6).fill(5_000_000);
    const ms = milestones([0, 1, 2, 3, 4, 5], flat);
    const api = 5_000_000;
    const plan = planChannel(api, api, ms, cfg, lcg(4));
    expect(plan.phase).toBe('target-bounce');
    expect(plan.netDelta).toBe(0);
    expect(sum(plan.events)).toBe(0);
    // unit(5M → 10,000) × 0.03 = 300
    expect(plan.events.some((e) => e.magnitude === 300)).toBe(true);
    expect(plan.events.some((e) => e.magnitude === -300)).toBe(true);
  });

  it('하락 추세 normal: netDelta 음수, 이벤트 합 일치', () => {
    // 감소: latest 4,990,000, prev 5,000,000 → step −10k
    // target = 4,990,000 + 0.95×(−10,000) = 4,980,500 / full = −9,500
    const counts = [5_040_000, 5_030_000, 5_020_000, 5_010_000, 5_000_000, 4_990_000];
    const ms = milestones([0, 2, 4, 6, 8, 10], counts);
    const api = 4_990_000;
    const plan = planChannel(api, api, ms, cfg, lcg(5));
    expect(plan.phase).toBe('normal');
    expect(plan.target).toBe(4_980_500);
    expect(plan.netDelta).toBeLessThan(0);
    expect(sum(plan.events)).toBe(plan.netDelta);
  });
});
