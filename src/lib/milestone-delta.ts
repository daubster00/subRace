// 마일스톤 히스토리(subscriber_snapshots) → expected_daily_delta 계산.
//
// 이 모듈은 순수 계산만 한다. DB 쿼리는 호출 측(M5 display-planner 등)이
// `MILESTONE_HISTORY_WINDOW_DAYS`로 필터링한 행을 전달.
//
// 알고리즘: 가중 최소제곱 선형 회귀.
//   y = subscriber_count
//   x = -age_days  (newer → 큰 x → 양의 기울기 = 성장)
//   w = exp(-max(0, age_days) / HALF_LIFE)
//     - 30일 전 = 0.50, 60일 전 = 0.25, 120일 전 = 0.0625
//     - 미래 날짜 행(SocialBlade 예측)은 age 음수 → max(0,_)로 clamp.
//       x 위치는 그대로 시간축에 두지만 weight는 1을 넘지 않게.

const MS_PER_DAY = 86_400_000;

// 회귀 가능 최소 표본 수. 2개로는 회귀가 두 점을 지나는 직선이라 정보 없음.
const MIN_SAMPLES = 3;

export interface RegressionPoint {
  x: number;      // 일반적으로 -age_days
  y: number;
  weight: number; // 음이 아닌 값
}

// 가중 최소제곱 회귀 y = a + b·x 의 기울기 b 반환.
//
//   b = (S·Sxy − Sx·Sy) / (S·Sxx − Sx²)
//
// 표본 부족(< MIN_SAMPLES) 또는 x 분산 0(분모 0)이면 null.
export function weightedLeastSquaresSlope(points: RegressionPoint[]): number | null {
  if (points.length < MIN_SAMPLES) return null;

  let S = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
  for (const { x, y, weight } of points) {
    S   += weight;
    Sx  += weight * x;
    Sy  += weight * y;
    Sxx += weight * x * x;
    Sxy += weight * x * y;
  }
  const denominator = S * Sxx - Sx * Sx;
  if (denominator === 0) return null;
  return (S * Sxy - Sx * Sy) / denominator;
}

export interface MilestoneRow {
  polled_at: string;       // ISO timestamp
  subscriber_count: number;
}

export interface ExpectedDailyDelta {
  expectedDailyDelta: number;  // 구독자/일. 음수 가능(감소 채널).
  sampleCount: number;
  halfLifeDays: number;
}

// window 내 마일스톤 행들을 받아 expected_daily_delta(구독자/일)를 계산.
//
// 호출 측 책임:
//   - rows는 한 채널의 (polled_at, subscriber_count) 시계열
//   - window 필터링(MILESTONE_HISTORY_WINDOW_DAYS)은 SQL 쪽에서 처리 후 전달
//
// 표본 < MIN_SAMPLES 또는 회귀 불가(모든 polled_at 동일)면 null.
// 호출 측에서 fallback 결정(예: api-bucket 기반 최소 rate).
export function computeExpectedDailyDelta(
  rows: MilestoneRow[],
  opts: { now?: Date; halfLifeDays: number },
): ExpectedDailyDelta | null {
  if (rows.length < MIN_SAMPLES) return null;

  const nowMs = (opts.now ?? new Date()).getTime();
  const halfLife = opts.halfLifeDays;

  const points: RegressionPoint[] = rows.map((r) => {
    const ageDays = (nowMs - new Date(r.polled_at).getTime()) / MS_PER_DAY;
    return {
      x: -ageDays,
      y: r.subscriber_count,
      weight: Math.exp(-Math.max(0, ageDays) / halfLife),
    };
  });

  const slope = weightedLeastSquaresSlope(points);
  if (slope === null) return null;

  return {
    expectedDailyDelta: slope,
    sampleCount: rows.length,
    halfLifeDays: halfLife,
  };
}
