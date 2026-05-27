import { describe, it, expect } from 'vitest';
import {
  getStepBounds,
  getChangeCountBounds,
  decideTier,
  getFallbackDailyDelta,
  computeTargetAndDelta,
  decideChangeCount,
  pickFirstIntervalMs,
  shouldReplan,
} from './display-plan';

describe('getStepBounds', () => {
  it('< 100k → 1~3', () => {
    expect(getStepBounds(50_000)).toEqual({ min: 1, max: 3 });
  });
  it('100k~1M → 2~10', () => {
    expect(getStepBounds(500_000)).toEqual({ min: 2, max: 10 });
  });
  it('1M~10M → 5~30', () => {
    expect(getStepBounds(5_000_000)).toEqual({ min: 5, max: 30 });
  });
  it('≥10M → 10~80', () => {
    expect(getStepBounds(75_400_000)).toEqual({ min: 10, max: 80 });
  });
});

describe('decideTier', () => {
  it('rank ≤ displayLimit → exposed', () => {
    expect(decideTier(1, 50, 20)).toBe('exposed');
    expect(decideTier(50, 50, 20)).toBe('exposed');
  });
  it('buffer 안 → exposed', () => {
    expect(decideTier(51, 50, 20)).toBe('exposed');
    expect(decideTier(70, 50, 20)).toBe('exposed');
  });
  it('buffer 밖 → waiting', () => {
    expect(decideTier(71, 50, 20)).toBe('waiting');
    expect(decideTier(150, 50, 20)).toBe('waiting');
  });
});

describe('getChangeCountBounds', () => {
  it('exposed: 30~720', () => {
    expect(getChangeCountBounds('exposed')).toEqual({ min: 30, max: 720 });
  });
  it('waiting: 10~240', () => {
    expect(getChangeCountBounds('waiting')).toEqual({ min: 10, max: 240 });
  });
});

describe('getFallbackDailyDelta', () => {
  it('<10M: unit=10_000 → 83.33/day', () => {
    expect(getFallbackDailyDelta(50_000)).toBeCloseTo(10_000 / 120, 6);
  });
  it('75M: unit=100_000 → 833.33/day', () => {
    expect(getFallbackDailyDelta(75_400_000)).toBeCloseTo(100_000 / 120, 6);
  });
  it('≥100M: unit=1M → 8333/day', () => {
    expect(getFallbackDailyDelta(123_000_000)).toBeCloseTo(1_000_000 / 120, 6);
  });
});

describe('computeTargetAndDelta', () => {
  it('양의 delta, cap 충분: target = display + delta', () => {
    const result = computeTargetAndDelta({
      display: 75_400_000,
      api: 75_400_000,
      cap: 75_485_000,
      expectedDailyDelta: 50_000,
    });
    expect(result.target).toBe(75_450_000);
    expect(result.todayDelta).toBe(50_000);
  });

  it('양의 delta, cap이 좁음: target = cap', () => {
    const result = computeTargetAndDelta({
      display: 75_480_000,
      api: 75_400_000,
      cap: 75_485_000,
      expectedDailyDelta: 50_000,
    });
    expect(result.target).toBe(75_485_000);
    expect(result.todayDelta).toBe(5_000);
  });

  it('음의 delta, display > api: api까지 내려갈 여지', () => {
    const result = computeTargetAndDelta({
      display: 1_000_000,
      api: 950_000,
      cap: 958_500,
      expectedDailyDelta: -30_000,
    });
    expect(result.target).toBe(970_000);
    expect(result.todayDelta).toBe(-30_000);
  });

  it('음의 delta, api가 하한: 더 내려가지 않음', () => {
    const result = computeTargetAndDelta({
      display: 1_000_000,
      api: 980_000,
      cap: 988_500,
      expectedDailyDelta: -100_000,
    });
    expect(result.target).toBe(980_000); // max(900_000, 980_000)
    expect(result.todayDelta).toBe(-20_000);
  });

  it('delta = 0: target = display, todayDelta = 0', () => {
    const result = computeTargetAndDelta({
      display: 100_000,
      api: 100_000,
      cap: 108_500,
      expectedDailyDelta: 0,
    });
    expect(result.target).toBe(100_000);
    expect(result.todayDelta).toBe(0);
  });
});

describe('decideChangeCount', () => {
  // rng 고정 — jitter 영향 분리.
  const constRng = (v: number) => () => v;

  it('큰 delta, exposed: tier max 안에서 raw 유지', () => {
    const n = decideChangeCount({
      todayDelta: 100_000,
      stepBounds: { min: 50, max: 500 },
      tier: 'exposed',
      rng: constRng(0.5), // jitter = 1.0
    });
    // |delta| / meanStep = 100_000 / 275 ≈ 363.6 → round 364. clamp [30,720] = 364.
    expect(n).toBe(364);
  });

  it('작은 delta, waiting: tier min으로 clamp', () => {
    const n = decideChangeCount({
      todayDelta: 1,
      stepBounds: { min: 50, max: 500 },
      tier: 'waiting',
      rng: constRng(0.5), // jitter = 1.0
    });
    expect(n).toBe(10); // waiting min
  });

  it('jitter 0.8× (rng=0)', () => {
    // raw = 5000/275 = 18.18 → 18, clamp [30,720] = 30 (tier min 보호),
    // * 0.8 = 24 → final max(30, 24) = 30.
    const mid = decideChangeCount({
      todayDelta: 5_000,
      stepBounds: { min: 50, max: 500 },
      tier: 'exposed',
      rng: constRng(0),
    });
    expect(mid).toBe(30);
  });

  it('jitter 1.2× (rng=1)', () => {
    // clamped = 30 (tier min). * 1.2 = 36 → 36.
    const mid = decideChangeCount({
      todayDelta: 5_000,
      stepBounds: { min: 50, max: 500 },
      tier: 'exposed',
      rng: constRng(1),
    });
    expect(mid).toBe(36);
  });
});

describe('pickFirstIntervalMs', () => {
  const DAY = 86_400_000;
  it('changeCount 0: 남은 시간 그대로 (or MIN)', () => {
    const ms = pickFirstIntervalMs({
      remainingMs: DAY,
      remainingChanges: 0,
      jitterRatio: 0.5,
    });
    expect(ms).toBe(DAY);
  });

  it('jitter 0: 정확히 평균', () => {
    const ms = pickFirstIntervalMs({
      remainingMs: DAY,
      remainingChanges: 100,
      jitterRatio: 0,
      rng: () => 0.5,
    });
    expect(ms).toBe(DAY / 100); // 864_000ms
  });

  it('jitter 0.5, rng=0 → 0.5×mean', () => {
    const ms = pickFirstIntervalMs({
      remainingMs: DAY,
      remainingChanges: 100,
      jitterRatio: 0.5,
      rng: () => 0,
    });
    expect(ms).toBeCloseTo(DAY / 100 * 0.5, -3);
  });

  it('jitter 0.5, rng=1 → 1.5×mean', () => {
    const ms = pickFirstIntervalMs({
      remainingMs: DAY,
      remainingChanges: 100,
      jitterRatio: 0.5,
      rng: () => 1,
    });
    expect(ms).toBeCloseTo(DAY / 100 * 1.5, -3);
  });

  it('MIN_INTERVAL_MS 하한 (60s): 매우 많은 changes', () => {
    const ms = pickFirstIntervalMs({
      remainingMs: 10_000, // 10s
      remainingChanges: 100,
      jitterRatio: 0,
      rng: () => 0.5,
    });
    expect(ms).toBe(60_000); // 10s/100 = 100ms < 60s → 60s
  });
});

describe('shouldReplan', () => {
  const POLL = { last_api_changed_at: '2026-05-27T09:00:00.000Z' };

  it('display 없음 → true (신규)', () => {
    expect(shouldReplan({
      display: null,
      poll: POLL,
      jstToday: '2026-05-27',
    })).toBe(true);
  });

  it('plan_date != today → true (일일 리셋)', () => {
    expect(shouldReplan({
      display: {
        plan_date: '2026-05-26',
        updated_at: '2026-05-26T15:00:00.000Z',
      },
      poll: POLL,
      jstToday: '2026-05-27',
    })).toBe(true);
  });

  it('api changed > display updated → true (mid-day API 변경)', () => {
    expect(shouldReplan({
      display: {
        plan_date: '2026-05-27',
        updated_at: '2026-05-27T08:00:00.000Z',
      },
      poll: POLL, // 09:00
      jstToday: '2026-05-27',
    })).toBe(true);
  });

  it('api changed ≤ display updated, 같은 날: false', () => {
    expect(shouldReplan({
      display: {
        plan_date: '2026-05-27',
        updated_at: '2026-05-27T10:00:00.000Z',
      },
      poll: POLL, // 09:00
      jstToday: '2026-05-27',
    })).toBe(false);
  });

  it('last_api_changed_at null, 같은 날: false', () => {
    expect(shouldReplan({
      display: {
        plan_date: '2026-05-27',
        updated_at: '2026-05-27T10:00:00.000Z',
      },
      poll: { last_api_changed_at: null },
      jstToday: '2026-05-27',
    })).toBe(false);
  });
});
