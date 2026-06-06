// 사전 스케줄 이벤트 생성 — 순수 함수 (DB·시간 의존 없음, rng 주입 가능).
//
// 한 채널의 1시간 사이클에 대해 (시각 offset, 부호 있는 magnitude) 이벤트 배열을
// 만든다. 핵심 불변식:
//   1. Σ magnitude === netDelta            (정확히 일치 — 마지막 보정 불필요)
//   2. |각 magnitude| <= maxMagnitude       (절대 상한 ±20, 항목 4 해소)
//   3. 이벤트 수 >= minEvents               (시간당 최소 6 — 화면 안 멈춤)
//   4. 추세/반대 방향 개수 고정(확률 X)      (80/20 → 우연한 몰림 구조적 불가, 항목 6)
//   5. 시각은 균등 분배 + jitter             (메트로놈 방지 + 휴식 구간)

export interface ScheduledEvent {
  offsetMs: number;  // 사이클 시작으로부터의 ms. [0, cycleMs)
  magnitude: number; // 부호 있음. + 증가 / − 감소
}

function defaultRng(): number {
  return Math.random();
}

// total(>=0)을 n개 정수로 최대한 고르게 분할. 각 <= maxEach. 합 === total.
//   base = floor(total/n), 앞쪽 rem개가 base+1.
// 호출 측이 n >= ceil(total/maxEach)를 보장하면 base+1 <= maxEach.
function distributeInt(total: number, n: number, maxEach: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  let rem = total - base * n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    if (v > maxEach) v = maxEach; // 방어 (정상 입력에선 도달 안 함)
    out.push(v);
  }
  return out;
}

// Fisher–Yates (rng 주입). 합 보존, 순서만 섞음.
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// 부호 있는 magnitude 슬롯 배열에 시각을 부여. 균등 분배 + ±jitter.
function assignTimes(
  magnitudes: number[],
  cycleMs: number,
  jitterRatio: number,
  rng: () => number,
): ScheduledEvent[] {
  const n = magnitudes.length;
  const slot = cycleMs / n;
  const events: ScheduledEvent[] = magnitudes.map((magnitude, i) => {
    // 슬롯 중앙 + ±(jitterRatio/2)*slot 흔들기 → 휴식 간격이 자연 분산.
    const jitter = (rng() - 0.5) * jitterRatio * slot;
    let offsetMs = Math.round(i * slot + slot / 2 + jitter);
    if (offsetMs < 0) offsetMs = 0;
    if (offsetMs >= cycleMs) offsetMs = cycleMs - 1;
    return { offsetMs, magnitude };
  });
  events.sort((a, b) => a.offsetMs - b.offsetMs);
  return events;
}

export interface BuildCycleOpts {
  netDelta: number;       // 이 사이클의 목표 순변화량 (부호 있음)
  cycleMs: number;        // 사이클 길이 (보통 1시간)
  minEvents: number;      // 시간당 최소 이벤트 수 (6)
  maxMagnitude: number;   // 이벤트당 절대 상한 (20)
  counterRatio: number;   // 반대 방향 이벤트 비율 (정상 0.20, catch-up 0)
  jitterRatio: number;    // 시각 jitter 비율 (0~1)
  rng?: () => number;
}

// 일반 사이클 (catch-up / normal). Σ magnitude === netDelta.
export function buildCycleEvents(opts: BuildCycleOpts): ScheduledEvent[] {
  const rng = opts.rng ?? defaultRng;
  const { cycleMs, minEvents, maxMagnitude, counterRatio, jitterRatio } = opts;
  const trendDir = opts.netDelta >= 0 ? 1 : -1;
  const absNet = Math.abs(opts.netDelta);

  // 추세 용량만으로 필요한 최소 이벤트 수.
  const baseN = Math.max(minEvents, Math.ceil(absNet / maxMagnitude) || 1);

  // 반대 방향 이벤트 수 (개수 고정 — 확률 아님).
  const nCounter = counterRatio > 0 ? Math.round(baseN * counterRatio) : 0;

  // 반대 이벤트 1개당 크기 — 작게. 평균 추세 크기의 절반 수준, 최소 1.
  const counterEach =
    nCounter > 0
      ? Math.min(maxMagnitude, Math.max(1, Math.round(absNet / baseN / 2)))
      : 0;
  const totalCounter = nCounter * counterEach;

  // 추세 이벤트가 채워야 할 총량 = 순변화 + 반대분 상쇄.
  const requiredTrend = absNet + totalCounter;
  const nTrend = Math.max(
    baseN - nCounter,
    Math.ceil(requiredTrend / maxMagnitude) || 1,
    1,
  );

  const trendMags = shuffle(distributeInt(requiredTrend, nTrend, maxMagnitude), rng)
    .map((m) => trendDir * m);
  const counterMags: number[] = Array.from({ length: nCounter }, () => -trendDir * counterEach);

  // 반대 이벤트를 슬롯에 고르게 끼워넣기 (한 군데 몰리지 않게).
  const merged = interleave(trendMags, counterMags);

  return assignTimes(merged, cycleMs, jitterRatio, rng);
}

// trend 다수 + counter 소수를, counter가 균등 간격으로 박히도록 병합.
function interleave(trend: number[], counter: number[]): number[] {
  const total = trend.length + counter.length;
  if (counter.length === 0) return trend.slice();
  const out: number[] = [];
  let ti = 0;
  let ci = 0;
  // counter를 균등 위치에 배치할 슬롯 인덱스 집합.
  const counterSlots = new Set<number>();
  const gap = total / counter.length;
  for (let c = 0; c < counter.length; c++) {
    counterSlots.add(Math.min(total - 1, Math.floor(gap * c + gap / 2)));
  }
  for (let i = 0; i < total; i++) {
    if (counterSlots.has(i) && ci < counter.length) {
      out.push(counter[ci++]!);
    } else if (ti < trend.length) {
      out.push(trend[ti++]!);
    } else if (ci < counter.length) {
      out.push(counter[ci++]!);
    }
  }
  return out;
}

export interface BuildBounceOpts {
  amplitude: number;   // 진동 폭 (±3% of step). >= 1
  count: number;       // 이벤트 수 (>= minEvents)
  cycleMs: number;
  jitterRatio: number;
  rng?: () => number;
}

// target 도달 후 진동 (target-bounce). 순변화 0, ± 교대.
//   위/아래 동수로 net 0. count가 홀수면 마지막 1개는 0 magnitude(no-op)로 맞춰
//   net 0을 보장.
export function buildBounceEvents(opts: BuildBounceOpts): ScheduledEvent[] {
  const rng = opts.rng ?? defaultRng;
  const amp = Math.max(1, Math.round(opts.amplitude));
  const n = Math.max(2, opts.count);

  const pairs = Math.floor(n / 2);
  const mags: number[] = [];
  for (let i = 0; i < pairs; i++) {
    mags.push(amp, -amp);
  }
  if (mags.length < n) mags.push(0); // 홀수 보정 — net 0 유지

  return assignTimes(mags, opts.cycleMs, opts.jitterRatio, rng);
}
