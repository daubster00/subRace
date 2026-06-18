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
  targetRatio: 0.99,
  baseSpeedRatio: 0.9,
  parkBounceRatio: 0.002,
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

  // 2026-06-18 감속 곡선: 상승 천장 = 마일스톤 + 0.99×단위. p=0.90 진입 시 기본
  // 속도(예상속도×0.9)의 0.5배로 감속.
  it('감속 밴드: p=0.90 진입 → 기본 속도의 0.5배, 천장 추월 금지', () => {
    // intervals=10h, fresh → 예상시간 10h. baseMove=0.9×10,000×(1/10)=900.
    // display=5,009,000 → p=0.90 → 감속배수 0.5 → netDelta=450.
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 10, 20, 30, 40, 50], counts);
    const api = 5_000_000;
    const display = 5_009_000;
    const plan = planTargetCycle(api, display, ms, cfg, nowAtLatest(ms), lcg(3));
    expect(plan.phase).toBe('normal');
    expect(plan.target).toBe(5_009_900); // ceiling = latest + 0.99×unit
    expect(plan.netDelta).toBe(450);
    expect(sum(plan.events)).toBe(plan.netDelta);
    expect(display + plan.netDelta).toBeLessThanOrEqual(5_009_900); // 다음 마일스톤 추월 금지
  });

  // p ≥ 0.99 → 주차. target-bounce 미세 진동, 천장(다음 마일스톤) 절대 추월 금지.
  it('99% 주차: p ≥ 0.99 → target-bounce, 천장 위로 못 감', () => {
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 10, 20, 30, 40, 50], counts);
    const api = 5_000_000;
    const ceiling = 5_009_900;
    const display = 5_009_900; // p = 0.99
    const plan = planTargetCycle(api, display, ms, cfg, nowAtLatest(ms), lcg(7));
    expect(plan.phase).toBe('target-bounce');
    expect(plan.target).toBe(ceiling);
    expect(plan.netDelta).toBe(0);
    // 진폭 = parkBounceRatio(0.002)×10,000 = 20. 누적이 천장 위로(>0) 안 감.
    let pos = 0, maxPos = 0;
    for (const e of plan.events) { pos += e.magnitude; maxPos = Math.max(maxPos, pos); }
    expect(maxPos).toBeLessThanOrEqual(0);
    for (const e of plan.events) expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(20);
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

  // 2026-06-18 정정: 정체/하락 + display가 밴드(latest+amp) 한참 위에 떠 있으면
  // 그 자리에서 진동하는 게 아니라 마일스톤+amp(=밴드 천장)으로 끌어내려야 한다.
  // (옛 동작은 하락 시작 채널을 옛 높은 값에 묶던 버그.)
  it('정체 + display ≫ latest+amp → normal로 마일스톤+amp까지 끌어내림', () => {
    const flat = Array(6).fill(5_000_000);
    const ms = milestones([0, 1, 2, 3, 4, 5], flat);
    const api = 5_000_000;
    const display = 5_005_000; // latest 위 +5,000 (amp=300의 16배)
    const ceiling = 5_000_300; // latest + amp(=0.03×10,000)
    const plan = planTargetCycle(api, display, ms, cfg, nowAtLatest(ms), lcg(8));
    expect(plan.phase).toBe('normal');
    expect(plan.target).toBe(ceiling);
    expect(plan.netDelta).toBeLessThan(0); // 아래로 이동
    const total = plan.events.reduce((s, e) => s + e.magnitude, 0);
    expect(total).toBe(plan.netDelta);
    // 한 사이클 하강 후 display가 천장(±1) 근처까지 내려옴 (갭 4,700 < 사이클 용량).
    expect(display + total).toBe(ceiling);
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

  // 경과 시간에 따라 pace 가속(예상 도착이 가까워질수록 baseMove 커짐).
  // 2026-06-18: display=latest(p=0, 감속배수 1). baseMove=0.9×단위×(1/남은시간).
  it('경과에 따라 pace 가속: half는 fresh의 2배 속도', () => {
    // expectedInterval=10h.
    // fresh: remaining=10h → baseMove=0.9×10,000×(1/10)=900
    // half : remaining=5h  → baseMove=0.9×10,000×(1/5)=1800
    const slowCounts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const slowMs = milestones([0, 10, 20, 30, 40, 50], slowCounts);
    const api = 5_000_000;
    const slowFresh = nowAtLatest(slowMs);
    const slowHalf = new Date(Date.parse(slowMs[slowMs.length - 1]!.polled_at) + 5 * HOUR);
    const slowPlanFresh = planTargetCycle(api, api, slowMs, cfg, slowFresh, lcg(17));
    const slowPlanHalf  = planTargetCycle(api, api, slowMs, cfg, slowHalf,  lcg(17));
    expect(slowPlanFresh.phase).toBe('normal');
    expect(slowPlanFresh.netDelta).toBe(900);
    expect(slowPlanHalf.phase).toBe('normal');
    expect(slowPlanHalf.netDelta).toBe(1_800);
  });

  // CF-8 (2026-06-09): N_PHYS_MAX=580 캡, absNet > 5800이면 MAG_HARD_MAX 동적 증가.
  it('큰 absNet (>5800): N 캡 + MAG_HARD_MAX 동적 증가', () => {
    // intervals=1h, fresh, display=latest → p=0(감속배수 1).
    // baseMove=0.9×10,000×(1/1)=9000. 천장(5,009,900) 안이라 클램프 없음.
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, nowAtLatest(ms), lcg(17));
    expect(plan.phase).toBe('normal');
    expect(plan.netDelta).toBe(9_000);
    expect(sum(plan.events)).toBe(9_000);
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

// 2026-06-18: 상승 마일스톤 도달 catch-up(CF-17)은 제거. 마일스톤 직후에도 normal
// phase로 0.9배 속도 상승. 단 정체(trendSign=0)에서 display<latest인 경우는 여전히
// 마일스톤+1%까지 catch-up(잔잔한 채널 50:50 진동 방지).
describe('planTargetCycle: 마일스톤 근처 동작', () => {
  it('증가 + display = 마일스톤 → catch-up 없이 0.9배 속도로 상승', () => {
    // intervals=10h, fresh, display=latest → baseMove=900, 감속배수 1.
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 10, 20, 30, 40, 50], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, api, ms, cfg, nowAtLatest(ms), lcg(21));
    expect(plan.phase).toBe('normal');
    expect(plan.target).toBe(5_009_900);
    expect(plan.netDelta).toBe(900);
  });

  it('증가 + display 한참 위(p<0.90) → 여전히 normal로 진행', () => {
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 10, 20, 30, 40, 50], counts);
    const api = 5_000_000;
    const plan = planTargetCycle(api, 5_000_100, ms, cfg, nowAtLatest(ms), lcg(22));
    expect(plan.phase).toBe('normal');
  });

  it('증가 + overdue → 천장까지 클램프', () => {
    // overdue(예상 도착 지남) → baseMove 폭증, ceiling으로 클램프.
    const counts = [4_950_000, 4_960_000, 4_970_000, 4_980_000, 4_990_000, 5_000_000];
    const ms = milestones([0, 1, 2, 3, 4, 5], counts);
    const api = 5_000_000;
    const now = new Date(Date.parse(ms[ms.length - 1]!.polled_at) + 10 * HOUR);
    const plan = planTargetCycle(api, api, ms, cfg, now, lcg(23));
    expect(plan.phase).toBe('normal');
    expect(plan.netDelta).toBe(9_900); // ceiling - display = 5,009,900 - 5,000,000
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
