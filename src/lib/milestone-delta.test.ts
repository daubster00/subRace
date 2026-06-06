import { describe, it, expect } from 'vitest';
import {
  computeMilestoneTarget,
  computePredictedHoursToNextMilestone,
  type MilestoneRow,
} from './milestone-delta';

const HOUR = 3_600_000;

function row(hoursAgoFromBase: number, count: number, base = Date.parse('2026-06-06T00:00:00.000Z')): MilestoneRow {
  return { polled_at: new Date(base + hoursAgoFromBase * HOUR).toISOString(), subscriber_count: count };
}

describe('computeMilestoneTarget (규칙 4)', () => {
  it('상승: target = latest + 0.95×(latest−prev)', () => {
    const rows = [row(0, 5_680_000), row(1, 5_690_000)];
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.latest).toBe(5_690_000);
    expect(t.prev).toBe(5_680_000);
    expect(t.trendSign).toBe(1);
    expect(t.target).toBe(5_699_500); // 5,690,000 + 0.95×10,000
  });

  it('하락: 음수 step → target 아래로', () => {
    const rows = [row(0, 626_000), row(1, 625_000)];
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.trendSign).toBe(-1);
    expect(t.target).toBe(624_050); // 625,000 + 0.95×(−1,000)
  });

  it('latest와 같은 값이 연속이면 값이 다른 직전 마일스톤을 prev로 찾는다', () => {
    // 진동 재진입: 5680 → 5690 → 5690 (같은 값 재도래)
    const rows = [row(0, 5_680_000), row(1, 5_690_000), row(2, 5_690_000)];
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.prev).toBe(5_680_000);
    expect(t.trendSign).toBe(1);
  });

  it('모든 값 동일 → trendSign 0, target = latest', () => {
    const rows = [row(0, 5_000_000), row(1, 5_000_000)];
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.trendSign).toBe(0);
    expect(t.target).toBe(5_000_000);
  });

  it('빈 배열 → null', () => {
    expect(computeMilestoneTarget([], 0.95)).toBeNull();
  });
});

describe('computePredictedHoursToNextMilestone (규칙 3)', () => {
  it('단일 간격: 그 간격 그대로', () => {
    const rows = [row(0, 100), row(2, 110)]; // 2시간 간격
    expect(computePredictedHoursToNextMilestone(rows, { maxIntervals: 8 })).toBeCloseTo(2, 6);
  });

  it('최신 간격에 더 큰 weight (순서 기반 선형)', () => {
    // 간격: 1h(옛, weight1), 2h(최신, weight2) → (1×1 + 2×2)/(1+2) = 5/3
    const rows = [row(0, 100), row(1, 110), row(3, 120)];
    expect(computePredictedHoursToNextMilestone(rows, { maxIntervals: 8 })).toBeCloseTo(5 / 3, 6);
  });

  it('maxIntervals로 최근 간격만 사용', () => {
    // 간격 4개: 10h, 10h, 1h, 1h. maxIntervals=2면 최근 1h,1h만 → weighted avg 1
    const rows = [row(0, 1), row(10, 2), row(20, 3), row(21, 4), row(22, 5)];
    expect(computePredictedHoursToNextMilestone(rows, { maxIntervals: 2 })).toBeCloseTo(1, 6);
  });

  it('마일스톤 < 2개 → null', () => {
    expect(computePredictedHoursToNextMilestone([row(0, 100)], { maxIntervals: 8 })).toBeNull();
    expect(computePredictedHoursToNextMilestone([], { maxIntervals: 8 })).toBeNull();
  });
});
