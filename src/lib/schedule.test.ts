import { describe, it, expect } from 'vitest';
import { buildCatchUpEvents, buildCycleEvents, buildBounceEvents } from './schedule';

// 결정적 rng (LCG) — 테스트 재현성.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CYCLE = 3_600_000; // 1h

describe('buildCycleEvents', () => {
  const base = {
    cycleMs: CYCLE,
    minEvents: 6,
    maxMagnitude: 20,
    jitterRatio: 0.5,
  };

  it('Σ magnitude === netDelta (정상, counterRatio 0.2) — 여러 net에 대해', () => {
    for (const net of [0, 5, 37, 120, 480, -55, -300, 1000, -1000]) {
      const rng = lcg(net + 100000);
      const events = buildCycleEvents({ ...base, netDelta: net, counterRatio: 0.2, rng });
      const sum = events.reduce((a, e) => a + e.magnitude, 0);
      expect(sum).toBe(net);
    }
  });

  it('Σ magnitude === netDelta (catch-up, counterRatio 0)', () => {
    for (const net of [50, 300, -200, 7]) {
      const rng = lcg(net + 7);
      const events = buildCycleEvents({ ...base, netDelta: net, counterRatio: 0, rng });
      expect(events.reduce((a, e) => a + e.magnitude, 0)).toBe(net);
    }
  });

  it('|각 magnitude| <= maxMagnitude', () => {
    const rng = lcg(42);
    const events = buildCycleEvents({ ...base, netDelta: 480, counterRatio: 0.2, rng });
    for (const e of events) expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(20);
  });

  it('이벤트 수 >= minEvents', () => {
    const rng = lcg(1);
    const events = buildCycleEvents({ ...base, netDelta: 3, counterRatio: 0.2, rng });
    expect(events.length).toBeGreaterThanOrEqual(6);
  });

  it('catch-up: 모든 이벤트가 같은 방향 (반대 0개)', () => {
    const rng = lcg(9);
    const events = buildCycleEvents({ ...base, netDelta: 300, counterRatio: 0, rng });
    expect(events.every((e) => e.magnitude > 0)).toBe(true);
  });

  it('normal 상승: 반대(감소) 이벤트가 일부 섞인다', () => {
    const rng = lcg(123);
    const events = buildCycleEvents({ ...base, netDelta: 400, counterRatio: 0.2, rng });
    expect(events.some((e) => e.magnitude < 0)).toBe(true);
    expect(events.some((e) => e.magnitude > 0)).toBe(true);
  });

  it('offset은 [0, cycleMs) 범위 + 정렬됨', () => {
    const rng = lcg(55);
    const events = buildCycleEvents({ ...base, netDelta: 200, counterRatio: 0.2, rng });
    for (const e of events) {
      expect(e.offsetMs).toBeGreaterThanOrEqual(0);
      expect(e.offsetMs).toBeLessThan(CYCLE);
    }
    const offsets = events.map((e) => e.offsetMs);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  // 다양성 (2026-06-08): 큰 absNet에서 magnitude가 maxMag에 몰리지 않고 분포.
  it('magnitude 분산: 큰 absNet에서 3가지 이상 절대값', () => {
    for (const net of [300, 500, 1000, -800]) {
      const rng = lcg(net + 9999);
      const events = buildCycleEvents({
        ...base,
        minEvents: 40,
        netDelta: net,
        counterRatio: 0.3,
        rng,
      });
      const uniqueAbs = new Set(events.map((e) => Math.abs(e.magnitude)));
      expect(uniqueAbs.size, `net=${net} mags=${[...uniqueAbs]}`).toBeGreaterThanOrEqual(3);
      // 합 일치 회귀 검증.
      expect(events.reduce((a, e) => a + e.magnitude, 0)).toBe(net);
    }
  });

  it('magnitude 분산: catch-up(counterRatio=0)도 평탄화 안 됨', () => {
    const rng = lcg(31415);
    const events = buildCycleEvents({
      ...base,
      minEvents: 40,
      netDelta: 800,
      counterRatio: 0,
      rng,
    });
    const uniqueAbs = new Set(events.map((e) => Math.abs(e.magnitude)));
    expect(uniqueAbs.size).toBeGreaterThanOrEqual(3);
    expect(events.reduce((a, e) => a + e.magnitude, 0)).toBe(800);
  });
});

describe('buildCatchUpEvents', () => {
  const base = { intervalMs: 3_000, maxMagnitude: 40 };

  it('Σ magnitude === netDelta (감소분 추세가 흡수)', () => {
    for (const net of [40, 50, 199, 1_000, 10_000, -75, -2_345]) {
      const rng = lcg(net + 1);
      const events = buildCatchUpEvents({ ...base, netDelta: net, rng });
      expect(events.reduce((a, e) => a + e.magnitude, 0)).toBe(net);
    }
  });

  it('작은 net (N<10): 단방향, 휴식·감소 없음, 순수 i×interval', () => {
    // 다양화로 T = ceil(absNet / (maxMag×0.7)) = ceil(absNet/28). T<10 → absNet ≤ 252
    // (정확히는 252까지 T=9). 그 이하는 R=0, C=0 → 순수 3s 페이스.
    for (const net of [40, 100, 200, 252, -150]) {
      const rng = lcg(net + 333);
      const events = buildCatchUpEvents({ ...base, netDelta: net, rng });
      const dir = net > 0 ? 1 : -1;
      expect(events.every((e) => Math.sign(e.magnitude) === dir)).toBe(true);
      events.forEach((e, i) => expect(e.offsetMs).toBe(i * 3_000));
    }
  });

  it('|각 magnitude| ≤ maxMagnitude', () => {
    const rng = lcg(99);
    const events = buildCatchUpEvents({ ...base, netDelta: 12_345, rng });
    for (const e of events) expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(40);
  });

  it('큰 net: 감소 슬롯 ≤ 5%, 각 -1 (또는 +1 하향 시)', () => {
    const rng = lcg(444);
    const events = buildCatchUpEvents({ ...base, netDelta: 10_000, rng });
    const counter = events.filter((e) => e.magnitude < 0);
    expect(counter.length / events.length).toBeLessThanOrEqual(0.05);
    expect(counter.length).toBeGreaterThan(0);
    expect(counter.every((e) => e.magnitude === -1)).toBe(true);
  });

  it('큰 net 하향: 감소 슬롯 magnitude는 +1', () => {
    const rng = lcg(555);
    const events = buildCatchUpEvents({ ...base, netDelta: -10_000, rng });
    const counter = events.filter((e) => e.magnitude > 0);
    expect(counter.length).toBeGreaterThan(0);
    expect(counter.every((e) => e.magnitude === 1)).toBe(true);
  });

  it('휴식 슬롯 ≤ 10% (인접 간격 > 3s인 쌍 비율)', () => {
    const rng = lcg(11);
    const events = buildCatchUpEvents({ ...base, netDelta: 5_000, rng });
    let restCount = 0;
    let maxGap = 0;
    for (let i = 1; i < events.length; i++) {
      const gap = events[i]!.offsetMs - events[i - 1]!.offsetMs;
      expect(gap).toBeGreaterThanOrEqual(3_000);
      if (gap > 3_000) restCount++;
      maxGap = Math.max(maxGap, gap);
    }
    expect(restCount / events.length).toBeLessThanOrEqual(0.10);
    // 휴식 한 번에 추가 ≤ 2s → 최대 인접 간격 ≤ 3s + 2s.
    expect(maxGap).toBeLessThanOrEqual(3_000 + 2_000);
  });

  it('netDelta=0 → 빈 스케줄', () => {
    const events = buildCatchUpEvents({ ...base, netDelta: 0 });
    expect(events).toHaveLength(0);
  });

  it('큰 갭(50k): 합 일치, magnitude 다양', () => {
    const rng = lcg(123);
    const events = buildCatchUpEvents({ ...base, netDelta: 50_000, rng });
    expect(events.reduce((a, e) => a + e.magnitude, 0)).toBe(50_000);
    // 다양화: T = ceil(50000/28) ≈ 1786 trend + C ≈ 94 counter → N ≈ 1880.
    expect(events.length).toBeGreaterThanOrEqual(1_780);
    expect(events.length).toBeLessThanOrEqual(1_950);
    // 모든 추세 슬롯이 40으로 평탄화되지 않아야 함 (=평균 ≈ 28).
    const trendMags = events.filter((e) => e.magnitude > 0).map((e) => e.magnitude);
    const uniqueTrend = new Set(trendMags);
    expect(uniqueTrend.size).toBeGreaterThan(5);
  });
});

describe('buildBounceEvents', () => {
  it('Σ magnitude === 0 (net 0 진동)', () => {
    for (const count of [6, 7, 8, 11]) {
      const rng = lcg(count);
      const events = buildBounceEvents({ amplitude: 300, count, cycleMs: CYCLE, jitterRatio: 0.5, rng });
      expect(events.reduce((a, e) => a + e.magnitude, 0)).toBe(0);
    }
  });

  it('amplitude 폭 사용, count 이상', () => {
    const rng = lcg(3);
    const events = buildBounceEvents({ amplitude: 300, count: 6, cycleMs: CYCLE, jitterRatio: 0.5, rng });
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(events.some((e) => e.magnitude === 300)).toBe(true);
    expect(events.some((e) => e.magnitude === -300)).toBe(true);
  });
});
