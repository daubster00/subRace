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
  // 헬퍼: now=latest milestone 시각 → elapsed=0 → remaining=expectedInterval.
  // 이 케이스로 expectedInterval 계산식만 격리해 검증.
  const justAfterLatest = (rows: MilestoneRow[]): Date =>
    new Date(rows[rows.length - 1]!.polled_at);

  it('단일 간격: now=latest이면 그 간격 그대로 남는다', () => {
    const rows = [row(0, 100), row(2, 110)]; // 2시간 간격
    expect(
      computePredictedHoursToNextMilestone(rows, {
        maxIntervals: 8,
        now: justAfterLatest(rows),
      })
    ).toBeCloseTo(2, 6);
  });

  it('최신 간격에 더 큰 weight (순서 기반 선형)', () => {
    // 간격: 1h(옛, weight1), 2h(최신, weight2) → (1×1 + 2×2)/(1+2) = 5/3
    const rows = [row(0, 100), row(1, 110), row(3, 120)];
    expect(
      computePredictedHoursToNextMilestone(rows, {
        maxIntervals: 8,
        now: justAfterLatest(rows),
      })
    ).toBeCloseTo(5 / 3, 6);
  });

  it('maxIntervals로 최근 간격만 사용', () => {
    // 간격 4개: 10h, 10h, 1h, 1h. maxIntervals=2면 최근 1h,1h만 → weighted avg 1
    const rows = [row(0, 1), row(10, 2), row(20, 3), row(21, 4), row(22, 5)];
    expect(
      computePredictedHoursToNextMilestone(rows, {
        maxIntervals: 2,
        now: justAfterLatest(rows),
      })
    ).toBeCloseTo(1, 6);
  });

  it('마일스톤 < 2개 → null', () => {
    const ts = new Date('2026-06-06T00:00:00.000Z');
    expect(
      computePredictedHoursToNextMilestone([row(0, 100)], { maxIntervals: 8, now: ts })
    ).toBeNull();
    expect(
      computePredictedHoursToNextMilestone([], { maxIntervals: 8, now: ts })
    ).toBeNull();
  });

  it('경과 시간만큼 남은 시간 감소: now가 latest 1시간 후면 expectedInterval−1', () => {
    // expectedInterval = 5h. now = latest + 1h → 남은 시간 = 4h.
    const rows = [row(0, 100), row(5, 110)];
    const now = new Date(Date.parse(rows[1]!.polled_at) + 1 * HOUR);
    expect(
      computePredictedHoursToNextMilestone(rows, { maxIntervals: 8, now })
    ).toBeCloseTo(4, 6);
  });

  it('overdue: now가 예상 도착 시각을 지나치면 epsilon(0.001) 반환', () => {
    // expectedInterval = 2h. now = latest + 10h → 8시간 지각.
    const rows = [row(0, 100), row(2, 110)];
    const now = new Date(Date.parse(rows[1]!.polled_at) + 10 * HOUR);
    expect(
      computePredictedHoursToNextMilestone(rows, { maxIntervals: 8, now })
    ).toBeCloseTo(0.001, 6);
  });

  it('ISSEI 시나리오: 가중평균 69h인데 145.5h 경과 → overdue epsilon', () => {
    // 평균 간격 ~72h가 나오도록 단순화: 3개 마일스톤, 간격 72h, 72h.
    // 가중평균 = (72×1 + 72×2) / 3 = 72.
    const base = Date.parse('2026-06-03T00:00:00.000Z');
    const rows: MilestoneRow[] = [
      { polled_at: new Date(base - 144 * HOUR).toISOString(), subscriber_count: 75_400_000 },
      { polled_at: new Date(base - 72 * HOUR).toISOString(),  subscriber_count: 75_500_000 },
      { polled_at: new Date(base).toISOString(),              subscriber_count: 75_600_000 },
    ];
    // now = latest + 145.5h (06-09 01:30 UTC)
    const now = new Date(base + 145.5 * HOUR);
    expect(
      computePredictedHoursToNextMilestone(rows, { maxIntervals: 8, now })
    ).toBeCloseTo(0.001, 6);
  });
});
