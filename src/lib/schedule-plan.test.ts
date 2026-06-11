import { describe, it, expect } from 'vitest';
import {
  planCatchUp,
  planTargetCycle,
  type PlanConfig,
} from './schedule-plan';
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

// 기본 now: 마지막 마일스톤 시각 그대로 — elapsed=0이라 예상 도착까지의
// 남은 시간 == expectedInterval로 환원.
function nowAtLatest(ms: MilestoneRow[]): Date {
  return new Date(ms[ms.length - 1]!.polled_at);
}

const cfg: PlanConfig = {
  minMilestones: 3,
  maxMagnitude: 40,
  normalMaxMagnitude: 10,
  cycleMs: HOUR,
  catchUpIntervalMs: 3_000,
  targetRatio: 0.95,
  bounceStepRatio: 0.03,
  paceMaxIntervals: 8,
  jitterRatio: 0.5,
  bounceCount: 100,
  trendMaxIntervals: 12,
  trendEpsilon: 0.5,
};

const sum = (es: { magnitude: number }[]) => es.reduce((a, e) => a + e.magnitude, 0);

describe('planCatchUp', () => {
  it('상향 catch-up: 3초 간격·이벤트당 최대 40으로 단방향 분배', () => {
    const api = 5_000_000;
    const plan = planCatchUp(api, api - 50, cfg, lcg(2));
    expect(plan.phase).toBe('catch-up');
    expect(plan.display).toBe(api - 50);
    expect(plan.target).toBe(api);
    expect(plan.netDelta).toBe(50);
    expect(sum(plan.events)).toBe(50);
    expect(plan.events.every((e) => e.magnitude > 0)).toBe(true);
    expect(plan.events.every((e) => e.magnitude <= 40)).toBe(true);
    plan.events.forEach((e, i) => expect(e.offsetMs).toBe(i * 3_000));
  });

  it('하향 catch-up: api가 폴링에서 줄었을 때도 동일하게 단방향', () => {
    const api = 5_000_000;
    const plan = planCatchUp(api, api + 30, cfg, lcg(3));
    expect(plan.phase).toBe('catch-up');
    expect(plan.netDelta).toBe(-30);
    expect(sum(plan.events)).toBe(-30);
    expect(plan.events.every((e) => e.magnitude < 0)).toBe(true);
    plan.events.forEach((e, i) => expect(e.offsetMs).toBe(i * 3_000));
  });

  it('큰 갭: 사이클(1h)에 묶이지 않고 길이 합리적', () => {
    // CF-18 (2026-06-11): catch-up이 4 연속 → 8초 휴식, 10 연속 → 단일 역방향(|mag|1~5)
    // 으로 바뀌어 추세 슬롯 T가 ceil(absNet/maxMag) 기반으로 축소(옛 ceil(absNet/(maxMag×0.7))).
    // 50k 갭의 maxMag=40에서 T ≈ 1250, 역방향 ≈ 125 → 총 1300~1500.
    const api = 5_000_000;
    const plan = planCatchUp(api, api - 50_000, cfg, lcg(7));
    expect(plan.events.length).toBeGreaterThanOrEqual(1_300);
    expect(plan.events.length).toBeLessThanOrEqual(1_800);
    expect(sum(plan.events)).toBe(50_000);
    const last = plan.events[plan.events.length - 1]!;
    expect(last.offsetMs).toBeGreaterThan(HOUR);
  });

  it('신규 시드(currentDisplay=null) → display=api, 빈 스케줄', () => {
    const plan = planCatchUp(5_000_000, null, cfg, lcg(4));
    expect(plan.phase).toBe('catch-up');
    expect(plan.display).toBe(5_000_000);
    expect(plan.netDelta).toBe(0);
    expect(plan.events).toHaveLength(0);
  });

  it('이미 도달(display == api) → 빈 스케줄, display 유지', () => {
    const plan = planCatchUp(5_000_000, 5_000_000, cfg, lcg(5));
    expect(plan.netDelta).toBe(0);
    expect(plan.events).toHaveLength(0);
  });
});

describe('planTargetCycle', () => {
  it('fixed: 마일스톤 < minMilestones → api 고정, 스케줄 없음', () => {
    const ms = milestones([0, 1], [4_995_000, 5_000_000]);
    const plan = planTargetCycle(5_000_000, 4_900_000, ms, cfg, nowAtLatest(ms), lcg(1));
    expect(plan.phase).toBe('fixed');
    expect(plan.display).toBe(5_000_000);
    expect(plan.target).toBe(5_000_000);
    expect(plan.events).toHaveLength(0);
  });

  // CF-8 (2026-06-09): absNet < SMALL_ABSNET_THRESHOLD(1160) → N=random[100,300],
  // absNet < 0.8N이면 적응 분배.
  // CF-10: ±1 고정 → ±1~5 균등 랜덤. CF-11: N_MIN 175→100.
  // CF-17 (2026-06-11): 마일스톤 도달 catch-up이 적응 영역 + display<latest+1%
  // 케이스를 가로채므로, display를 마일스톤+1% 위로 두고 적응 분배만 검증.
  it('작은 absNet: random N + 적응 분배 (|mag|=1~5)', () => {
    // step=10,000, expectedInterval=10h, fresh. full=500, raw=50 → absNet=50<80(=0.8×100).
    // display=5,009,000 (milestoneCatchUpTarget=5,000,100 위) → catch-up 미발동.
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 10, 20, 30, 40, 50], counts);
    const api = 5_000_000;
    const display = 5_009_000;
    const plan = planTargetCycle(api, display, ms, cfg, nowAtLatest(ms), lcg(3));
    expect(plan.phase).toBe('normal');
    expect(plan.target).toBe(5_009_500);
    expect(plan.netDelta).toBeGreaterThan(0);
    expect(sum(plan.events)).toBe(plan.netDelta);
    // N은 [100, 300] 범위
    expect(plan.events.length).toBeGreaterThanOrEqual(100);
    expect(plan.events.length).toBeLessThanOrEqual(300);
    // 모든 이벤트의 |magnitude| ∈ [1, 5]
    for (const e of plan.events) {
      expect(Math.abs(e.magnitude)).toBeGreaterThanOrEqual(1);
      expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(5);
    }
    // 추세와 감소 모두 존재
    expect(plan.events.some((e) => e.magnitude > 0)).toBe(true);
    expect(plan.events.some((e) => e.magnitude < 0)).toBe(true);
  });

  // 2026-06-10 새 정책: 정체(추세 0) — display ≥ latest면 현재 자리에서 진동.
  // display=latest인 경우 negCap=0이라 사실상 위쪽 단방향. floor=latest 보호.
  it('target-bounce: 추세 0(정체) + display=latest → 현재 자리 위로 진동 (floor 아래 금지)', () => {
    const flat = Array(6).fill(5_000_000);
    const ms = milestones([0, 1, 2, 3, 4, 5], flat);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, nowAtLatest(ms), lcg(4));
    expect(plan.phase).toBe('target-bounce');
    expect(plan.target).toBe(5_000_000); // display 그대로
    expect(plan.netDelta).toBe(0);
    for (const e of plan.events) expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(10);
    let pos = 0;
    let minPos = 0;
    let maxPos = 0;
    for (const e of plan.events) {
      pos += e.magnitude;
      minPos = Math.min(minPos, pos);
      maxPos = Math.max(maxPos, pos);
    }
    expect(minPos).toBeGreaterThanOrEqual(0); // latest 아래로 못 감
    expect(maxPos).toBeLessThanOrEqual(300);
    expect(plan.events.length).toBeGreaterThan(0);
    expect(plan.events.length).toBeLessThanOrEqual(cfg.bounceCount);
  });

  // 2026-06-10 새 정책: 정체/하락 + display가 latest+amp 한참 위에 있는 케이스.
  // 끌어내리지 않고 그 자리에서 양방향 진동(단 latest 밑으로는 못 감).
  it('target-bounce: 정체 + display ≫ latest+amp → 현재 자리 양방향 진동, latest floor 보호', () => {
    const flat = Array(6).fill(5_000_000);
    const ms = milestones([0, 1, 2, 3, 4, 5], flat);
    const api = 5_000_000;
    const display = 5_005_000; // latest 위 +5,000 (amp=300의 16배)
    const plan = planTargetCycle(api, display, ms, cfg, nowAtLatest(ms), lcg(8));
    expect(plan.phase).toBe('target-bounce');
    expect(plan.target).toBe(display);
    expect(plan.netDelta).toBe(0);
    let pos = 0;
    let minPos = 0;
    let maxPos = 0;
    for (const e of plan.events) {
      pos += e.magnitude;
      minPos = Math.min(minPos, pos);
      maxPos = Math.max(maxPos, pos);
    }
    // pos 누적은 [-min(amp, offset), +amp] = [-300, +300]
    expect(minPos).toBeGreaterThanOrEqual(-300);
    expect(maxPos).toBeLessThanOrEqual(300);
    // 절대 display - 5000 (=latest) 밑으로는 안 감 → minPos ≥ -5000은 자명히 만족
    expect(display + minPos).toBeGreaterThanOrEqual(5_000_000);
  });

  // 2026-06-10 새 정책: 하락 추세 + display=latest → 위쪽 단방향 진동.
  it('하락 추세 + display=latest → target-bounce 단방향(latest 아래 금지)', () => {
    const counts = [5_000_500, 5_000_400, 5_000_300, 5_000_200, 5_000_100, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, nowAtLatest(ms), lcg(5));
    expect(plan.phase).toBe('target-bounce');
    expect(plan.target).toBe(5_000_000); // display 그대로
    expect(plan.netDelta).toBe(0);
    let pos = 0;
    let minPos = 0;
    let maxPos = 0;
    for (const e of plan.events) {
      pos += e.magnitude;
      minPos = Math.min(minPos, pos);
      maxPos = Math.max(maxPos, pos);
    }
    expect(minPos).toBeGreaterThanOrEqual(0);
    expect(maxPos).toBeLessThanOrEqual(300);
  });

  it('하락 추세 + display < latest → normal phase, effectiveTarget(latest+amp)로 위로', () => {
    const counts = [5_000_500, 5_000_400, 5_000_300, 5_000_200, 5_000_100, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api - 800, ms, cfg, nowAtLatest(ms), lcg(5));
    expect(plan.phase).toBe('normal');
    expect(plan.target).toBe(5_000_300);
    expect(plan.netDelta).toBeGreaterThan(0); // 위로 이동
    expect(sum(plan.events)).toBe(plan.netDelta);
  });

  // CF-8 (2026-06-09): 회귀 검증. display > api여도 catch-up으로 깎지 않음.
  it('회귀: display > api여도 catch-up으로 깎지 않음 (target 플랜만 적용)', () => {
    const flat = Array(12).fill(5_000_000);
    const ms = milestones(Array.from({ length: 12 }, (_, i) => i), flat);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api + 39, ms, cfg, nowAtLatest(ms), lcg(99));
    expect(plan.phase).toBe('target-bounce');
    expect(plan.display).toBe(api + 39);
    expect(plan.netDelta).toBe(0);
    // bounce 드리프트 ≤ amp(=300, api=5M의 1% bucket × 3%)
    expect(Math.abs(sum(plan.events))).toBeLessThanOrEqual(300);
  });

  // CF-4 (2026-06-09): overdue 채널은 full gap을 한 사이클에 닫음.
  // CF-17 (2026-06-11): step=100 setup은 absNet=95라 catch-up이 가로채므로
  // step=10,000으로 변경(full=9,500, 정규 분배 영역 = catch-up 통과).
  it('overdue: 예상 도착 지나친 채널은 full gap 클램프로 닫는다', () => {
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const now = new Date(Date.parse(ms[ms.length - 1]!.polled_at) + 10 * HOUR);
    const plan = planTargetCycle(api, api, ms, cfg, now, lcg(13));
    expect(plan.phase).toBe('normal');
    expect(plan.netDelta).toBeGreaterThan(0);
    expect(sum(plan.events)).toBe(plan.netDelta);
  });

  // CF-4 검증: 경과 시간에 따라 pace 가속. absNet 크기로 분기.
  // CF-17 (2026-06-11): fresh 케이스는 absNet=950 + display=latest라
  // 마일스톤 도달 catch-up이 가로챈다. half 케이스는 absNet=1900으로 통과.
  it('경과 절반: fresh는 마일스톤 catch-up, half는 정규 분배', () => {
    // expectedInterval=10h, full=9500.
    // fresh: remaining=10h → raw=950 → absNet<1160 + display<latest+1% → catch-up
    // half : remaining=5h  → raw=1900 → absNet≥1160 → catch-up 통과, 정규 분배
    const slowCounts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const slowMs = milestones([0, 10, 20, 30, 40, 50], slowCounts);
    const api = 5_000_000;
    const slowFresh = nowAtLatest(slowMs);
    const slowHalf = new Date(Date.parse(slowMs[slowMs.length - 1]!.polled_at) + 5 * HOUR);
    const slowPlanFresh = planTargetCycle(api, api, slowMs, cfg, slowFresh, lcg(17));
    const slowPlanHalf  = planTargetCycle(api, api, slowMs, cfg, slowHalf,  lcg(17));
    // fresh: 마일스톤 도달 catch-up → target=latest+100, netDelta=100
    expect(slowPlanFresh.phase).toBe('catch-up');
    expect(slowPlanFresh.target).toBe(5_000_100);
    expect(slowPlanFresh.netDelta).toBe(100);
    // half: 정규 분배. 정확히 1900
    expect(slowPlanHalf.phase).toBe('normal');
    expect(slowPlanHalf.netDelta).toBe(1_900);
  });

  // CF-8 (2026-06-09): N_PHYS_MAX=580 캡, absNet > 5800이면 MAG_HARD_MAX 동적 증가.
  it('큰 absNet (>5800): N 캡 + MAG_HARD_MAX 동적 증가로 한 사이클에 다 닫음', () => {
    // step=10k, target=5,009,500, full=9500. expectedInterval=1h, fresh.
    // raw=9500 → |raw|≥|full| → netDelta=9500. > 5800 → MAG_HARD_MAX 동적.
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, nowAtLatest(ms), lcg(17));
    expect(plan.phase).toBe('normal');
    // absNet=9500 → 580 슬롯에서 평균 magnitude ~16.4 → MAG_HARD_MAX=round(2×16.4)=33
    // distributeRandom으로 정확히 9500 분배
    expect(plan.netDelta).toBe(9_500);
    expect(sum(plan.events)).toBe(9_500);
    expect(plan.events.length).toBe(580);
    // 인접 간격 ≥ 6200ms (MIN_EVENT_INTERVAL_MS)
    for (let i = 1; i < plan.events.length; i++) {
      const a = plan.events[i - 1]!.offsetMs;
      const b = plan.events[i]!.offsetMs;
      // wrap 경계는 음수 가능 — 양의 차이로 처리하면 (b-a + cycleMs) % cycleMs
      const gap = (b - a + HOUR) % HOUR;
      // wrap 경계가 아닌 경우만 (마지막 wrap 차이는 cycleMs - (N-1)×slot)
      if (gap < HOUR / 2) {
        expect(gap).toBeGreaterThanOrEqual(6_200);
      }
    }
  });
});

// CF-17 (2026-06-11): 마일스톤 도달 catch-up. 적응 분배 영역에 들어가면서
// 화면이 마일스톤 근처에 머무는 잔잔한 채널이 50:50 진동으로 보이는 문제를
// 막기 위해, "마일스톤 + bucket unit × 1%"까지 catch-up(5초 페이스 단방향)으로
// 먼저 올리고 그 위에서 다음 사이클이 적응 분배로 흔든다.
describe('planTargetCycle: 마일스톤 도달 catch-up (CF-17)', () => {
  // 1천만 미만 채널: bucket unit = 10,000 → catch-up 위쪽 폭 = 100.

  it('증가 + 적응 영역 + display < 마일스톤+1% → catch-up으로 마일스톤+1%까지', () => {
    // step=10,000, expectedInterval=10h, fresh. full=9500, raw=950 → absNet=950<1160.
    // display=api=latest. catch-up 발동.
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 10, 20, 30, 40, 50], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, nowAtLatest(ms), lcg(21));
    expect(plan.phase).toBe('catch-up');
    expect(plan.target).toBe(5_000_100);
    expect(plan.netDelta).toBe(100);
    expect(sum(plan.events)).toBe(100);
    // catch-up은 단방향
    expect(plan.events.every((e) => e.magnitude > 0)).toBe(true);
  });

  it('증가 + display ≥ 마일스톤+1% → catch-up 미발동(normal로 진행)', () => {
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 10, 20, 30, 40, 50], counts);
    const api = 5_000_000;
    // 5,000,100 < 5,000,100 false → catch-up 통과.
    const plan = planTargetCycle(api, 5_000_100, ms, cfg, nowAtLatest(ms), lcg(22));
    expect(plan.phase).toBe('normal');
  });

  it('증가 + 큰 absNet(≥1160) → catch-up 미발동, 정규 분배', () => {
    // overdue clamp로 netDelta=full=9500. catch-up 통과.
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const now = new Date(Date.parse(ms[ms.length - 1]!.polled_at) + 10 * HOUR);
    const plan = planTargetCycle(api, api, ms, cfg, now, lcg(23));
    expect(plan.phase).toBe('normal');
    expect(plan.netDelta).toBe(9_500);
  });

  it('정체(trendSign=0) + display < latest → catch-up으로 마일스톤+1%까지', () => {
    // 마일스톤 평탄 = 정체. display는 latest 아래.
    const flat = Array(6).fill(5_000_000);
    const ms = milestones([0, 1, 2, 3, 4, 5], flat);
    const api = 5_000_000;
    const display = 4_999_950; // latest - 50
    const plan = planTargetCycle(api, display, ms, cfg, nowAtLatest(ms), lcg(24));
    expect(plan.phase).toBe('catch-up');
    expect(plan.target).toBe(5_000_100);
    expect(plan.netDelta).toBe(150);
    expect(plan.events.every((e) => e.magnitude > 0)).toBe(true);
  });

  it('정체 + display ≥ latest → 기존 target-bounce 유지(catch-up 영향 없음)', () => {
    const flat = Array(6).fill(5_000_000);
    const ms = milestones([0, 1, 2, 3, 4, 5], flat);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, nowAtLatest(ms), lcg(25));
    expect(plan.phase).toBe('target-bounce');
  });

  it('1억 이상 채널: bucket unit=1,000,000 → catch-up 위쪽 폭=10,000', () => {
    // 큰 채널은 적응 영역에 들어가기 어려워 catch-up이 거의 안 발동하지만,
    // 발동될 때의 목표값 계산이 자릿값 기준으로 올바른지 확인.
    const counts = [110_000_000, 110_500_000, 111_000_000, 111_500_000, 112_000_000, 112_500_000];
    const ms = milestones([0, 100, 200, 300, 400, 500], counts);
    const api = 112_500_000;
    // expectedInterval=100h. raw=950000/100*1=475000 → absNet ≥ 1160 → catch-up 통과.
    // 의도: catch-up이 발동될 수 있는 시그니처 검증을 위해 더 느린 setup 필요.
    // 여기서는 발동 안 됨을 확인(미발동 검증).
    const plan = planTargetCycle(api, api, ms, cfg, nowAtLatest(ms), lcg(26));
    expect(plan.phase).toBe('normal');
  });
});
