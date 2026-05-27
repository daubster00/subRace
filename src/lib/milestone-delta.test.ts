import { describe, it, expect } from 'vitest';
import {
  weightedLeastSquaresSlope,
  computeExpectedDailyDelta,
  type RegressionPoint,
  type MilestoneRow,
} from './milestone-delta';

const HALF_LIFE = 30;

function mkPoint(ageDays: number, count: number, halfLifeDays = HALF_LIFE): RegressionPoint {
  return {
    x: -ageDays,
    y: count,
    weight: Math.exp(-Math.max(0, ageDays) / halfLifeDays),
  };
}

// 절대 시각으로 만든 행(now 기준 ageDays 전 polled_at).
function mkRow(now: Date, ageDays: number, count: number): MilestoneRow {
  return {
    polled_at: new Date(now.getTime() - ageDays * 86_400_000).toISOString(),
    subscriber_count: count,
  };
}

describe('weightedLeastSquaresSlope', () => {
  it('완전 선형 +10/day 증가: 기울기 정확히 10', () => {
    // age=0 → y=1000, age=10 → y=900, ... → newer가 더 큼 → +10/day
    const points = [0, 10, 20, 30, 60].map((age) => mkPoint(age, 1000 - age * 10));
    const slope = weightedLeastSquaresSlope(points);
    expect(slope).not.toBeNull();
    expect(slope!).toBeCloseTo(10, 6);
  });

  it('완전 선형 -5/day 감소: 기울기 정확히 -5', () => {
    const points = [0, 10, 20, 30].map((age) => mkPoint(age, 1000 + age * 5));
    const slope = weightedLeastSquaresSlope(points);
    expect(slope).not.toBeNull();
    expect(slope!).toBeCloseTo(-5, 6);
  });

  it('표본 < 3 → null', () => {
    expect(weightedLeastSquaresSlope([])).toBeNull();
    expect(weightedLeastSquaresSlope([mkPoint(0, 100)])).toBeNull();
    expect(weightedLeastSquaresSlope([mkPoint(0, 100), mkPoint(10, 90)])).toBeNull();
  });

  it('모든 x 동일(시간 축 분산 0) → null', () => {
    const points: RegressionPoint[] = [
      { x: 0, y: 100, weight: 1 },
      { x: 0, y: 200, weight: 1 },
      { x: 0, y: 300, weight: 1 },
    ];
    expect(weightedLeastSquaresSlope(points)).toBeNull();
  });

  it('최근 가속: 가중치가 최근 기울기 쪽으로 끌어당김', () => {
    // 오래된 구간(age 60~90): +5/day
    // 최근 구간(age 0~30): +20/day
    // uniform 평균 ≈ 15, half-life=30이면 slope > 15
    const points: RegressionPoint[] = [
      mkPoint(90, 1000),
      mkPoint(75, 1075),
      mkPoint(60, 1150),
      mkPoint(30, 1750),
      mkPoint(15, 2050),
      mkPoint(0,  2350),
    ];
    const slope = weightedLeastSquaresSlope(points);
    expect(slope).not.toBeNull();
    expect(slope!).toBeGreaterThan(15);
    expect(slope!).toBeLessThanOrEqual(20);
  });

  it('half-life가 매우 크면(가중치 거의 균일) 단순 회귀와 같음', () => {
    const points = [0, 10, 20, 30, 40].map((age) => mkPoint(age, 1000 - age, 1e9));
    const slope = weightedLeastSquaresSlope(points);
    expect(slope!).toBeCloseTo(1, 6);
  });

  it('V자 추세 + 최근 가중: 최근 회복 방향(양수)으로 잡힘', () => {
    // age 60→30: -10/day 하락, age 30→0: +10/day 회복
    // uniform 평균 ≈ 0, half-life=20이면 최근 회복에 끌려 slope > 0
    const halfLife = 20;
    const points: RegressionPoint[] = [
      mkPoint(60, 1300, halfLife),
      mkPoint(45, 1150, halfLife),
      mkPoint(30, 1000, halfLife),
      mkPoint(15, 1150, halfLife),
      mkPoint(0,  1300, halfLife),
    ];
    const slope = weightedLeastSquaresSlope(points);
    expect(slope).not.toBeNull();
    expect(slope!).toBeGreaterThan(0);
  });
});

describe('computeExpectedDailyDelta', () => {
  const NOW = new Date('2026-05-27T00:00:00.000Z');

  it('완전 선형 +1000/day: expectedDailyDelta ≈ 1000', () => {
    const rows = [0, 10, 20, 30, 60].map((age) => mkRow(NOW, age, 100_000 - age * 1000));
    const result = computeExpectedDailyDelta(rows, { now: NOW, halfLifeDays: HALF_LIFE });
    expect(result).not.toBeNull();
    expect(result!.expectedDailyDelta).toBeCloseTo(1000, 3);
    expect(result!.sampleCount).toBe(5);
    expect(result!.halfLifeDays).toBe(HALF_LIFE);
  });

  it('표본 < 3 → null', () => {
    expect(computeExpectedDailyDelta([], { now: NOW, halfLifeDays: HALF_LIFE })).toBeNull();
    expect(computeExpectedDailyDelta(
      [mkRow(NOW, 0, 100), mkRow(NOW, 10, 90)],
      { now: NOW, halfLifeDays: HALF_LIFE },
    )).toBeNull();
  });

  it('감소 채널: 음수 expectedDailyDelta', () => {
    const rows = [0, 10, 20, 30].map((age) => mkRow(NOW, age, 100_000 + age * 500));
    const result = computeExpectedDailyDelta(rows, { now: NOW, halfLifeDays: HALF_LIFE });
    expect(result).not.toBeNull();
    expect(result!.expectedDailyDelta).toBeCloseTo(-500, 3);
  });

  it('미래 날짜 행(SocialBlade 예측) 포함해도 weight clamp되어 과대평가 없음', () => {
    // age 음수(미래) 1개 + 과거 4개. weight clamp 안 됐다면 미래 row가 ≫1
    // 가중치로 결과를 끌고 갔을 것. clamp되면 미래 row weight=1, 어제 row와 동급.
    const rows = [
      mkRow(NOW, -10, 110_000), // 10일 뒤 SB 예측: 11만
      mkRow(NOW,   0, 100_000),
      mkRow(NOW,  10,  90_000),
      mkRow(NOW,  20,  80_000),
      mkRow(NOW,  30,  70_000),
    ];
    // 5개 행이 정확히 직선(+1000/day) 위에 있으므로 어떤 가중치든 정확히 +1000
    const result = computeExpectedDailyDelta(rows, { now: NOW, halfLifeDays: HALF_LIFE });
    expect(result).not.toBeNull();
    expect(result!.expectedDailyDelta).toBeCloseTo(1000, 3);
  });
});
