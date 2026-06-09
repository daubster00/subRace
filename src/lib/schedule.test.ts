import { describe, it, expect } from 'vitest';
import {
  buildCatchUpEvents,
  buildCycleEvents,
  buildBounceEvents,
  MIN_EVENT_INTERVAL_MS,
} from './schedule';

// 결정적 rng (LCG) — 테스트 재현성.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const CYCLE = 3_600_000; // 1h

describe('buildCycleEvents (CF-8 신규 알고리즘)', () => {
  const base = {
    cycleMs: CYCLE,
    maxMagnitude: 10,
    jitterRatio: 0.5,
  };

  // 매우 작은 absNet → 항상 적응 분배 (|mag|=1~5 균등 랜덤).
  // 적응 분배 조건: absNet < 0.8N. N=random[175,300] → N_min×0.8=140
  // 따라서 absNet < 140이면 어떤 N에서도 적응 분배 보장.
  // CF-10: 모든 ±1 고정에서 ±1~5 균등 랜덤으로 변경. 합 기댓값 = absNet이지만
  // 슬롯별 랜덤 편차로 실제 합은 ±√N×stddev 흔들림 (다음 사이클이 자연 보정).
  it('매우 작은 absNet (<140): |magnitude| ∈ [1, 5]', () => {
    for (const net of [50, 100, 130, -50, -100]) {
      const rng = lcg(net + 100);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      expect(events.length).toBeGreaterThanOrEqual(175);
      expect(events.length).toBeLessThanOrEqual(300);
      for (const e of events) {
        expect(Math.abs(e.magnitude)).toBeGreaterThanOrEqual(1);
        expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(5);
      }
    }
  });

  // 작은~중간 absNet (140 ≤ absNet < 1160): N=random[175,300], 분기 가능.
  // 적응 분배(±1~5)면 합 오차 큼, 정규 분배면 정확.
  it('작은~중간 absNet: N은 [175, 300]', () => {
    for (const net of [200, 500, 800, -300, -700]) {
      const rng = lcg(net + 200);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      expect(events.length).toBeGreaterThanOrEqual(175);
      expect(events.length).toBeLessThanOrEqual(300);
    }
  });

  // 큰 absNet (≥ 1160 AND ≤ 5800) → 정규 분배. 합 정확.
  it('큰 absNet (정규 분배 영역): Σ magnitude === netDelta', () => {
    for (const net of [1160, 2000, 3000, 5000, -1500, -3000]) {
      const rng = lcg(net + 7);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      const sum = events.reduce((a, e) => a + e.magnitude, 0);
      expect(sum).toBe(net);
    }
  });

  it('|각 magnitude| ≤ maxMagnitude (정규 분배)', () => {
    const rng = lcg(42);
    const events = buildCycleEvents({ ...base, netDelta: 2000, rng });
    for (const e of events) expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(10);
  });

  // CF-8: 양방향 항상 섞임 (적응 분배든 정규 분배든 감소 슬롯 존재).
  it('양방향 항상 섞임 — 추세와 감소 모두 존재', () => {
    for (const net of [200, 2000, -2000]) {
      const rng = lcg(net + 1);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      expect(events.some((e) => e.magnitude > 0)).toBe(true);
      expect(events.some((e) => e.magnitude < 0)).toBe(true);
    }
  });

  it('offset은 [0, cycleMs) 범위 + 정렬됨', () => {
    const rng = lcg(55);
    const events = buildCycleEvents({ ...base, netDelta: 2000, rng });
    for (const e of events) {
      expect(e.offsetMs).toBeGreaterThanOrEqual(0);
      expect(e.offsetMs).toBeLessThan(CYCLE);
    }
    const offsets = events.map((e) => e.offsetMs);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  // CF-8: 인접 간격 ≥ MIN_EVENT_INTERVAL_MS = 6,200ms (모션 + 휴식).
  it('인접 이벤트 간격 ≥ MIN_EVENT_INTERVAL_MS', () => {
    for (const net of [500, 3000, 8000]) {
      const rng = lcg(net + 99);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      // wrap된 boundary는 한 곳뿐 — 거기는 cycleMs − total_span으로 ≥ slot
      for (let i = 1; i < events.length; i++) {
        const gap = events[i]!.offsetMs - events[i - 1]!.offsetMs;
        expect(gap).toBeGreaterThanOrEqual(MIN_EVENT_INTERVAL_MS);
      }
    }
  });

  // CF-8: N_PHYS_MAX = 580 캡.
  it('N은 N_PHYS_MAX=580을 절대 넘지 않음', () => {
    for (const net of [3000, 5800, 10_000, 50_000]) {
      const rng = lcg(net + 7);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      expect(events.length).toBeLessThanOrEqual(580);
    }
  });

  // CF-8: 큰 absNet (>5800) → MAG_HARD_MAX 동적 증가로 한 사이클에 다 닫음.
  it('absNet > 5800: MAG_HARD_MAX 동적 증가, 합 정확', () => {
    for (const net of [6100, 10_000, 20_000, -8000]) {
      const rng = lcg(net + 17);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      expect(events.length).toBe(580);
      const sum = events.reduce((a, e) => a + e.magnitude, 0);
      expect(sum).toBe(net);
      // 평균 magnitude가 10을 초과하므로 일부 magnitude > 10 존재
      const maxMag = Math.max(...events.map((e) => Math.abs(e.magnitude)));
      expect(maxMag).toBeGreaterThan(10);
    }
  });

  it('netDelta=0 → 빈 스케줄', () => {
    const events = buildCycleEvents({ ...base, netDelta: 0, rng: lcg(0) });
    expect(events).toHaveLength(0);
  });

  // CF-8/CF-10: 작은 absNet (적응 분배)에서 빈 슬롯(0 magnitude) 없음.
  // CF-10에서 magnitude는 ±1~5 균등 랜덤이지만 0은 절대 박지 않는다.
  it('적응 분배: 모든 슬롯이 ±(1~5), 0 슬롯 없음', () => {
    const rng = lcg(123);
    const events = buildCycleEvents({ ...base, netDelta: 50, rng });
    for (const e of events) {
      expect(e.magnitude).not.toBe(0);
      expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(5);
    }
  });

  // 다양성: 정규 분배 (충분히 큰 absNet)에서 magnitude가 1~maxMag에 분포.
  it('정규 분배: magnitude가 1~maxMag 범위에 다양 분포', () => {
    const rng = lcg(31415);
    const events = buildCycleEvents({ ...base, netDelta: 3000, rng });
    const uniqueAbs = new Set(events.map((e) => Math.abs(e.magnitude)));
    expect(uniqueAbs.size).toBeGreaterThanOrEqual(3);
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
    expect(events.length).toBeGreaterThanOrEqual(1_780);
    expect(events.length).toBeLessThanOrEqual(1_950);
    const trendMags = events.filter((e) => e.magnitude > 0).map((e) => e.magnitude);
    const uniqueTrend = new Set(trendMags);
    expect(uniqueTrend.size).toBeGreaterThan(5);
  });
});

describe('buildBounceEvents', () => {
  // CF-10: |mag| ≤ BOUNCE_PER_EVENT_MAGNITUDE=5 (이전 10에서 변경).
  it('한 이벤트 |magnitude| ≤ 5 (BOUNCE_PER_EVENT_MAGNITUDE)', () => {
    for (const amp of [100, 1000, 10_000]) {
      const rng = lcg(amp);
      const events = buildBounceEvents({ amplitude: amp, count: 60, cycleMs: CYCLE, jitterRatio: 0.5, rng });
      for (const e of events) expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(5);
    }
  });

  it('누적 위치(running sum)가 ±amp 안에 머무름', () => {
    for (const amp of [100, 1000, 10_000]) {
      const rng = lcg(amp + 999);
      const events = buildBounceEvents({ amplitude: amp, count: 100, cycleMs: CYCLE, jitterRatio: 0.5, rng });
      let pos = 0;
      let maxAbs = 0;
      for (const e of events) {
        pos += e.magnitude;
        maxAbs = Math.max(maxAbs, Math.abs(pos));
      }
      expect(maxAbs).toBeLessThanOrEqual(amp);
    }
  });

  it('count 이상의 이벤트', () => {
    const rng = lcg(3);
    const events = buildBounceEvents({ amplitude: 300, count: 6, cycleMs: CYCLE, jitterRatio: 0.5, rng });
    expect(events.length).toBeGreaterThanOrEqual(6);
  });

  it('큰 amp + 충분한 count → ±10 범위에서 다양한 값 발생', () => {
    const rng = lcg(42);
    const events = buildBounceEvents({ amplitude: 1_000, count: 100, cycleMs: CYCLE, jitterRatio: 0.5, rng });
    const unique = new Set(events.map((e) => e.magnitude));
    expect(unique.size).toBeGreaterThan(5);
    expect(events.some((e) => e.magnitude > 0)).toBe(true);
    expect(events.some((e) => e.magnitude < 0)).toBe(true);
  });
});
