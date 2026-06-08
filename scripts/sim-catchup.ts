// catch-up 동작 시뮬레이션 — DB 없이 planCatchUp 출력만 검사.
//   pnpm tsx scripts/sim-catchup.ts          # 기본 absNet 세트
//   pnpm tsx scripts/sim-catchup.ts 50000    # 단일 absNet
//   pnpm tsx scripts/sim-catchup.ts 50000 -v # 이벤트 타임라인 일부 표시
import { planCatchUp, type PlanConfig } from '../src/lib/schedule-plan';

const cfg: PlanConfig = {
  minMilestones: 3,
  minEvents: 6,
  maxMagnitude: 40,
  normalMaxMagnitude: 10,
  counterRatio: 0.2,
  cycleMs: 3_600_000,
  catchUpIntervalMs: 5_000,
  targetRatio: 0.95,
  bounceStepRatio: 0.03,
  paceMaxIntervals: 8,
  jitterRatio: 0.5,
  activityNMin: 40,
  activityNMax: 100,
  activityPivot: 300,
};

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

function fmtTime(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

const argAbs = process.argv[2] ? Number(process.argv[2]) : null;
const verbose = process.argv.includes('-v');
const nets = argAbs ? [argAbs] : [50, 200, 600, 3_000, 10_000, 50_000];

const api = 5_000_000;

console.log('absNet  | events | trend | ctr | rests | total time | first 10 gaps        | end');
console.log('--------|--------|-------|-----|-------|------------|---------------------|----');

for (const absNet of nets) {
  const plan = planCatchUp(api, api - absNet, cfg, lcg(absNet + 1));
  const events = plan.events;
  const N = events.length;
  const sum = events.reduce((a, e) => a + e.magnitude, 0);
  const trend = events.filter((e) => e.magnitude > 0).length;
  const counter = events.filter((e) => e.magnitude < 0).length;
  // 휴식 = base interval(catchUpIntervalMs) 초과 인접 간격.
  let rests = 0;
  const gaps: number[] = [];
  for (let i = 1; i < N; i++) {
    const g = events[i]!.offsetMs - events[i - 1]!.offsetMs;
    gaps.push(g);
    if (g > cfg.catchUpIntervalMs) rests++;
  }
  const total = N > 0 ? events[N - 1]!.offsetMs : 0;
  const head = gaps.slice(0, 10).map((g) => `${(g / 1000).toFixed(1)}`).join(' ');
  const endTag = sum === absNet ? 'OK' : `BAD(${sum})`;
  console.log(
    `${String(absNet).padStart(7)} | ${String(N).padStart(6)} | ${String(trend).padStart(5)} | ${String(counter).padStart(3)} | ${String(rests).padStart(5)} | ${fmtTime(total).padStart(10)} | ${head.padEnd(20)} | ${endTag}`,
  );
}

if (verbose && argAbs) {
  const plan = planCatchUp(api, api - argAbs, cfg, lcg(argAbs + 1));
  console.log('\n타임라인 (처음 30개 + 마지막 5개):');
  console.log('idx | offset      | mag | gap');
  console.log('----|-------------|-----|------');
  const head = plan.events.slice(0, 30);
  const tail = plan.events.slice(-5);
  for (let i = 0; i < head.length; i++) {
    const e = head[i]!;
    const gap = i === 0 ? 0 : e.offsetMs - head[i - 1]!.offsetMs;
    const mark = gap > cfg.catchUpIntervalMs ? ' ← rest' : e.magnitude < 0 ? ' ← counter' : '';
    console.log(`${String(i).padStart(3)} | ${fmtTime(e.offsetMs).padStart(11)} | ${String(e.magnitude).padStart(3)} | ${(gap / 1000).toFixed(1).padStart(4)}s${mark}`);
  }
  if (plan.events.length > 35) console.log('...');
  for (let j = 0; j < tail.length; j++) {
    const i = plan.events.length - tail.length + j;
    const e = tail[j]!;
    const gap = i === 0 ? 0 : e.offsetMs - plan.events[i - 1]!.offsetMs;
    const mark = gap > cfg.catchUpIntervalMs ? ' ← rest' : e.magnitude < 0 ? ' ← counter' : '';
    console.log(`${String(i).padStart(3)} | ${fmtTime(e.offsetMs).padStart(11)} | ${String(e.magnitude).padStart(3)} | ${(gap / 1000).toFixed(1).padStart(4)}s${mark}`);
  }
}
