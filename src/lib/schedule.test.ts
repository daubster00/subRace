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
  // 적응 분배 조건: absNet < 0.8N. N=random[100,300] → N_min×0.8=80
  // 따라서 absNet < 80이면 어떤 N에서도 적응 분배 보장.
  // CF-10: ±1 고정 → ±1~5 균등 랜덤. CF-11: N_MIN 175→100.
  it('매우 작은 absNet (<80): |magnitude| ∈ [1, 5]', () => {
    for (const net of [10, 30, 50, 70, -10, -50]) {
      const rng = lcg(net + 100);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      expect(events.length).toBeGreaterThanOrEqual(100);
      expect(events.length).toBeLessThanOrEqual(300);
      for (const e of events) {
        expect(Math.abs(e.magnitude)).toBeGreaterThanOrEqual(1);
        expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(5);
      }
    }
  });

  // 작은~중간 absNet (80 ≤ absNet < 1160): N=random[100,300], 분기 가능.
  // 적응 분배(±1~5)면 합 오차 큼, 정규 분배면 정확.
  it('작은~중간 absNet: N은 [100, 300]', () => {
    for (const net of [200, 500, 800, -300, -700]) {
      const rng = lcg(net + 200);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      expect(events.length).toBeGreaterThanOrEqual(100);
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

  // CF-12: 트리거 조건 완화 (avgMag > magHardMax/2, 즉 absNet > N×5).
  // magHardMax = min(MAG_HARD_MAX_CAP=30, round(2×avg)).
  // absNet ≤ 580×30 = 17,400이면 한 사이클에 합 정확히 닫음.
  it('absNet 중간~큰 (3000~15000): magHardMax 동적 증가 + 합 정확', () => {
    for (const net of [3500, 6100, 10_000, 15_000, -8000]) {
      const rng = lcg(net + 17);
      const events = buildCycleEvents({ ...base, netDelta: net, rng });
      expect(events.length).toBe(580);
      const sum = events.reduce((a, e) => a + e.magnitude, 0);
      expect(sum).toBe(net);
      // |각 magnitude| ≤ MAG_HARD_MAX_CAP(=30)
      const maxMag = Math.max(...events.map((e) => Math.abs(e.magnitude)));
      expect(maxMag).toBeLessThanOrEqual(30);
    }
  });

  // CF-12: absNet이 N×CAP(=17,400) 넘으면 cap에 걸려 합 < absNet (다음 사이클 이월).
  it('absNet > N×CAP: 합 < absNet, max ≤ 30', () => {
    const rng = lcg(20_000);
    const events = buildCycleEvents({ ...base, netDelta: 20_000, rng });
    const sum = events.reduce((a, e) => a + e.magnitude, 0);
    expect(sum).toBeLessThan(20_000);
    for (const e of events) expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(30);
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
  // CF-18 (2026-06-11): 4 연속 → +8초 추가 휴식, 10 연속 → 단일 역방향(|mag|=1~5).
  const PAUSE_EXTRA_MS = 8_000;
  const COUNTER_RUN = 10;

  it('Σ magnitude === netDelta (역방향만큼 추세가 흡수)', () => {
    for (const net of [40, 50, 199, 1_000, 10_000, -75, -2_345]) {
      const rng = lcg(net + 1);
      const events = buildCatchUpEvents({ ...base, netDelta: net, rng });
      expect(events.reduce((a, e) => a + e.magnitude, 0)).toBe(net);
    }
  });

  it('작은 net (T<4): 단방향, 휴식·역방향 없음, 순수 i×interval', () => {
    // T=ceil(absNet/maxMag), maxMag=40. net=40 → T=1, net=120 → T=3.
    for (const net of [40, 80, 120, -120]) {
      const rng = lcg(net + 333);
      const events = buildCatchUpEvents({ ...base, netDelta: net, rng });
      const dir = net > 0 ? 1 : -1;
      expect(events.every((e) => Math.sign(e.magnitude) === dir)).toBe(true);
      events.forEach((e, i) => expect(e.offsetMs).toBe(i * 3_000));
    }
  });

  it('|각 magnitude| ≤ maxMagnitude (역방향 포함)', () => {
    const rng = lcg(99);
    const events = buildCatchUpEvents({ ...base, netDelta: 12_345, rng });
    for (const e of events) expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(40);
  });

  it('큰 net 상승: 10번째마다 역방향 단일 이벤트, |mag|∈[1,5]', () => {
    const rng = lcg(444);
    const events = buildCatchUpEvents({ ...base, netDelta: 10_000, rng });
    const counter = events.filter((e) => e.magnitude < 0);
    expect(counter.length).toBeGreaterThan(0);
    expect(counter.every((e) => e.magnitude >= -5 && e.magnitude <= -1)).toBe(true);
    // 추세 슬롯 T ≈ 250, 역방향 ≈ T/10 ≈ 25. 비율 약 9.5%.
    expect(counter.length / events.length).toBeLessThan(0.15);
    expect(counter.length / events.length).toBeGreaterThan(0.05);
  });

  it('큰 net 하향: 역방향은 양수, |mag|∈[1,5]', () => {
    const rng = lcg(555);
    const events = buildCatchUpEvents({ ...base, netDelta: -10_000, rng });
    const counter = events.filter((e) => e.magnitude > 0);
    expect(counter.length).toBeGreaterThan(0);
    expect(counter.every((e) => e.magnitude >= 1 && e.magnitude <= 5)).toBe(true);
  });

  it('4 연속 추세 후 다음 슬롯까지 13초 (intervalMs=3000 + 8000)', () => {
    const rng = lcg(11);
    const events = buildCatchUpEvents({ ...base, netDelta: 5_000, rng });
    let pauseGaps = 0;
    for (let i = 1; i < events.length; i++) {
      const gap = events[i]!.offsetMs - events[i - 1]!.offsetMs;
      // 최소 간격은 intervalMs, 최대는 intervalMs + PAUSE_EXTRA_MS.
      expect(gap).toBeGreaterThanOrEqual(3_000);
      expect(gap).toBeLessThanOrEqual(3_000 + PAUSE_EXTRA_MS);
      if (gap > 3_000 + 100) pauseGaps++;
    }
    // 추세 250개 중 4 연속마다 휴식이지만 10번째에선 역방향이 우선이라 휴식이 생략됨.
    // 따라서 휴식 ≈ T/4 − T/10 = T × 0.15 정도.
    expect(pauseGaps).toBeGreaterThan(0);
  });

  it('netDelta=0 → 빈 스케줄', () => {
    const events = buildCatchUpEvents({ ...base, netDelta: 0 });
    expect(events).toHaveLength(0);
  });

  it('큰 갭(50k): 합 일치, 길이 합리적', () => {
    const rng = lcg(123);
    const events = buildCatchUpEvents({ ...base, netDelta: 50_000, rng });
    expect(events.reduce((a, e) => a + e.magnitude, 0)).toBe(50_000);
    // 추세 T ≈ 50000/40 = 1250, 역방향 ≈ 125, 총 ≈ 1375. 큰 갭에선 평균이 maxMag에
    // 닿아 거의 모두 40에 클램프 — 다양화는 buildCycleEvents가 담당, catch-up은
    // 빠른 도달이 목적.
    expect(events.length).toBeGreaterThan(1_300);
    expect(events.length).toBeLessThan(1_800);
  });

  it('역방향 직후 카운터 리셋 (역방향 사이 추세 ≥ COUNTER_RUN-1 슬롯)', () => {
    const rng = lcg(777);
    const events = buildCatchUpEvents({ ...base, netDelta: 30_000, rng });
    // 음수 이벤트 직전까지 박힌 양수 추세 슬롯이 정확히 10개씩 들어 있어야 함.
    let runUp = 0;
    let counterCount = 0;
    let prevDirNegative = false;
    for (const e of events) {
      if (e.magnitude > 0) {
        if (prevDirNegative) runUp = 1;
        else runUp++;
        prevDirNegative = false;
      } else if (e.magnitude < 0) {
        counterCount++;
        expect(runUp).toBe(COUNTER_RUN);
        runUp = 0;
        prevDirNegative = true;
      }
    }
    expect(counterCount).toBeGreaterThan(50);
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
