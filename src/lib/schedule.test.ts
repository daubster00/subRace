import { describe, it, expect } from 'vitest';
import { buildCycleEvents, buildBounceEvents } from './schedule';

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
