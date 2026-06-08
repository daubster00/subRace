import { computeActivityN, computeDynamicCounterRatio } from '../src/lib/schedule-plan';
import { buildCycleEvents } from '../src/lib/schedule';

const cfg = {
  minMilestones: 3,
  minEvents: 6,
  maxMagnitude: 20,
  normalMaxMagnitude: 10,
  counterRatio: 0.2,
  cycleMs: 3_600_000,
  catchUpIntervalMs: 3_000,
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

function histogram(mags: number[], maxMag: number): string {
  // 1~maxMag 구간을 5칸 버킷으로 묶어 |||||... 표시.
  const buckets = [0, 0, 0, 0, 0];
  for (const m of mags) {
    if (m <= 0) continue;
    const i = Math.min(4, Math.floor((m - 1) / (maxMag / 5)));
    buckets[i]!++;
  }
  return buckets.map((c) => String(c).padStart(2)).join('|');
}

console.log('absNet | N   | ratio | tot | sum=net | uniq | trend hist (1-2|3-4|5-6|7-8|9-10)');
console.log('-------|-----|-------|-----|---------|------|---------------------------------------');

for (const absNet of [5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000, 2000]) {
  const N = computeActivityN(absNet, cfg);
  const ratio = computeDynamicCounterRatio(absNet, N, cfg.normalMaxMagnitude);
  const events = buildCycleEvents({
    netDelta: absNet,
    cycleMs: cfg.cycleMs,
    minEvents: N,
    maxMagnitude: cfg.normalMaxMagnitude,
    counterRatio: ratio,
    jitterRatio: cfg.jitterRatio,
    rng: lcg(absNet + 1),
  });
  const sum = events.reduce((a, e) => a + e.magnitude, 0);
  const posMags = events.filter((e) => e.magnitude > 0).map((e) => e.magnitude);
  const negMags = events.filter((e) => e.magnitude < 0).map((e) => -e.magnitude);
  const allAbsUnique = new Set(events.map((e) => Math.abs(e.magnitude)));
  const sumOk = sum === absNet ? 'OK' : `BAD(${sum})`;
  console.log(
    `${String(absNet).padStart(6)} | ${String(N).padStart(3)} | ${ratio.toFixed(3)} | ${String(events.length).padStart(3)} | ${sumOk.padStart(7)} | ${String(allAbsUnique.size).padStart(4)} | trend ${histogram(posMags, cfg.normalMaxMagnitude)}  counter ${histogram(negMags, cfg.normalMaxMagnitude)}`,
  );
}
