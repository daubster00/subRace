// 사전 스케줄 이벤트 생성 — 순수 함수 (DB·시간 의존 없음, rng 주입 가능).
//
// 한 채널의 1시간 사이클에 대해 (시각 offset, 부호 있는 magnitude) 이벤트 배열을
// 만든다. 핵심 불변식:
//   1. Σ magnitude === netDelta            (정확히 일치 — 마지막 보정 불필요)
//      단, 슬롯이 모션 간격 제약에 캡되면 absNet이 축소될 수 있음 → 호출 측이
//      Σ magnitude를 새 netDelta로 사용 (planTargetCycle).
//   2. |각 magnitude| <= maxMagnitude       (호출 측이 phase별로 주입: normal 10, catch-up 20)
//   3. 이벤트 수 >= minEvents               (시간당 최소 6 — 화면 안 멈춤)
//   4. 추세/반대 방향 개수 고정(확률 X)      (80/20 → 우연한 몰림 구조적 불가, 항목 6)
//   5. 시각은 균등 분배 + jitter             (메트로놈 방지 + 휴식 구간)
//   6. 인접 이벤트 간격 ≥ MIN_EVENT_INTERVAL_MS — 화면 모션이 한 번씩 완주.

// 클라이언트 테두리/숫자 모션 지속시간(useInterpolatedSnapshot.ts의
// MOTION_TOTAL_DURATION_MS와 동기). 이벤트가 이 값보다 짧은 간격으로 박히면
// 직전 모션이 끝나기 전에 새 모션이 덮어씌워져 테두리가 안 보이고 숫자만
// 폭주하는 것처럼 보임. 사이클당 슬롯 수의 절대 상한 + jitter 폭 상한을 이
// 값으로 강제한다(2026-06-09 customer feedback).
export const MIN_EVENT_INTERVAL_MS = 4_200;

export interface ScheduledEvent {
  offsetMs: number;  // 사이클 시작으로부터의 ms. [0, cycleMs)
  magnitude: number; // 부호 있음. + 증가 / − 감소
}

function defaultRng(): number {
  return Math.random();
}

// total을 n개 정수로 분배. 각 ∈ [1, maxEach]. 합 정확히 total.
//   분포 방식: 평균 avg = total/n 중심으로 ±variance 흔든 뒤 클램프, 잔차는
//   무작위 슬롯에 ±1로 흡수. distributeInt(균등)보다 자연스러운 다양성을
//   주려는 목적 — magnitude가 maxEach에 몰리던 문제 해소(2026-06-08).
//
// 사전조건: n * 1 <= total <= n * maxEach. 호출 측이 nTrend를 충분히 늘려
// avg가 maxEach에 못 미치도록 잡아야 분산 여지가 생긴다 (avg=maxEach면 모두
// maxEach로 클램프 — 분산 0).
function distributeRandom(
  total: number,
  n: number,
  maxEach: number,
  rng: () => number,
): number[] {
  if (n <= 0) return [];
  const minEach = 1;
  // 안전망: 입력이 사전조건을 벗어나면 균등 폴백.
  if (total <= n * minEach) {
    const out = Array<number>(n).fill(minEach);
    let rem = total - n * minEach;
    while (rem > 0) { out[Math.floor(rng() * n)]!++; rem--; }
    while (rem < 0) {
      const idx = Math.floor(rng() * n);
      if (out[idx]! > 0) { out[idx]!--; rem++; }
    }
    return out;
  }
  if (total >= n * maxEach) return Array<number>(n).fill(maxEach);

  const avg = total / n;
  // 분산 폭: avg와 양쪽 클램프 한계 중 좁은 쪽 × 0.8. avg가 양 끝에 가까울
  // 수록 변동 폭이 자연히 좁아져 클램프로 인한 평탄화를 방지.
  const variance = Math.min(avg - minEach, maxEach - avg) * 0.8;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = Math.round(avg + (rng() - 0.5) * 2 * variance);
    out.push(Math.max(minEach, Math.min(maxEach, v)));
  }

  // 합 보정: 차이만큼 자격 슬롯(maxEach 미달/minEach 초과)에 ±1.
  let diff = total - out.reduce((a, b) => a + b, 0);
  while (diff > 0) {
    const eligible: number[] = [];
    for (let i = 0; i < n; i++) if (out[i]! < maxEach) eligible.push(i);
    if (eligible.length === 0) break;
    out[eligible[Math.floor(rng() * eligible.length)]!]!++;
    diff--;
  }
  while (diff < 0) {
    const eligible: number[] = [];
    for (let i = 0; i < n; i++) if (out[i]! > minEach) eligible.push(i);
    if (eligible.length === 0) break;
    out[eligible[Math.floor(rng() * eligible.length)]!]!--;
    diff++;
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
//
// jitter 폭은 두 제약 중 작은 쪽으로 클램프:
//   (a) 원래 jitterRatio 기반 폭        = jitterRatio × slot / 2
//   (b) 인접 간격 ≥ MIN_EVENT_INTERVAL_MS 보장 폭 = max(0, (slot − MIN) / 2)
// 슬롯이 빠듯할수록(MIN에 가까울수록) jitter는 0에 수렴.
function assignTimes(
  magnitudes: number[],
  cycleMs: number,
  jitterRatio: number,
  rng: () => number,
): ScheduledEvent[] {
  const n = magnitudes.length;
  const slot = cycleMs / n;
  const safeJitterMax = Math.max(0, (slot - MIN_EVENT_INTERVAL_MS) / 2);
  const rawJitterMax = (jitterRatio * slot) / 2;
  const jitterMax = Math.min(rawJitterMax, safeJitterMax);
  const events: ScheduledEvent[] = magnitudes.map((magnitude, i) => {
    const jitter = (rng() - 0.5) * 2 * jitterMax;
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
//
// 다양성 확보(2026-06-08): trend slot 수를 ceil(requiredTrend / (maxMag×0.7))
// 까지 확장해 평균 magnitude가 maxMag 한참 아래로 떨어지게 한다. 그 위에
// distributeRandom으로 평균±분산 분배 → 한 사이클 안에 magnitude가 1~maxMag
// 범위에 자연 분포한다(과거: 거의 maxMag로 평탄화).
export function buildCycleEvents(opts: BuildCycleOpts): ScheduledEvent[] {
  const rng = opts.rng ?? defaultRng;
  const { cycleMs, minEvents, maxMagnitude, counterRatio, jitterRatio } = opts;
  const trendDir = opts.netDelta >= 0 ? 1 : -1;
  let absNet = Math.abs(opts.netDelta);

  // 추세 용량만으로 필요한 최소 이벤트 수.
  const baseN = Math.max(minEvents, Math.ceil(absNet / maxMagnitude) || 1);

  // 반대 방향 이벤트 수 (개수 고정 — 확률 아님).
  let nCounter = counterRatio > 0 ? Math.round(baseN * counterRatio) : 0;

  // 반대 이벤트 1개당 평균 크기 — 작게. 평균 추세 크기의 절반 수준, 최소 1.
  const counterEachAvg =
    nCounter > 0
      ? Math.min(maxMagnitude, Math.max(1, Math.round(absNet / baseN / 2)))
      : 0;
  let totalCounter = nCounter * counterEachAvg;

  // 추세 이벤트가 채워야 할 총량 = 순변화 + 반대분 상쇄.
  let requiredTrend = absNet + totalCounter;
  // 다양화 항: 평균 magnitude를 maxMag * 0.7로 캡 → slot 수가 자동 확장.
  const nTrendDiverse = Math.ceil(requiredTrend / (maxMagnitude * 0.7)) || 1;
  let nTrend = Math.max(
    baseN - nCounter,
    Math.ceil(requiredTrend / maxMagnitude) || 1,
    nTrendDiverse,
    1,
  );

  // 4.2초 간격 제약: 슬롯이 사이클 / MIN_INTERVAL_MS를 넘으면 캡.
  // 캡되면 추세/반대 슬롯을 비율 그대로 축소하고 absNet도 슬롯 용량(추세
  // 슬롯 × maxMag − totalCounter)에 맞춰 줄인다. 모자라는 양은 다음 사이클이
  // 자동으로 닫는다 — display_state.target은 그대로라 다음 plan이 gap만큼
  // 새 absNet을 다시 계산.
  const maxEventsBySpacing = Math.floor(cycleMs / MIN_EVENT_INTERVAL_MS);
  if (nTrend + nCounter > maxEventsBySpacing) {
    const totalN = nTrend + nCounter;
    nCounter = Math.floor(nCounter * (maxEventsBySpacing / totalN));
    nTrend = Math.max(1, maxEventsBySpacing - nCounter);
    totalCounter = nCounter * counterEachAvg;
    const cappedRequiredTrend = nTrend * maxMagnitude;
    requiredTrend = Math.min(requiredTrend, cappedRequiredTrend);
    absNet = Math.max(0, requiredTrend - totalCounter);
  }

  if (absNet === 0 && requiredTrend === 0) return [];

  const trendMags = shuffle(distributeRandom(requiredTrend, nTrend, maxMagnitude, rng), rng)
    .map((m) => trendDir * m);
  const counterMags: number[] =
    nCounter > 0
      ? distributeRandom(totalCounter, nCounter, maxMagnitude, rng).map((m) => -trendDir * m)
      : [];

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

export interface BuildCatchUpOpts {
  netDelta: number;       // 따라잡을 순변화 (부호 있음)
  intervalMs: number;     // 이벤트 사이 고정 간격 (기본 3000ms)
  maxMagnitude: number;   // 이벤트당 절대 상한 (기본 40)
  rng?: () => number;
}

// catch-up 자연스러움 파라미터 (2026-06-08 customer feedback). 향후 env 승격 여지.
//   REST_RATIO   : 휴식 슬롯 비율 상한 — 총 이벤트 수의 10% 이내.
//   REST_MIN/MAX : 휴식 한 번당 0.5~2.0초.
//   COUNTER_RATIO: 감소 슬롯 비율 상한 — 총 이벤트 수의 5% 이내.
//   COUNTER_MAG  : 감소 슬롯 한 번당 1 (subscriber). "내려가는 것처럼만 보이게".
const CATCHUP_REST_RATIO    = 0.10;
const CATCHUP_REST_MIN_MS   = 500;
const CATCHUP_REST_MAX_MS   = 2_000;
const CATCHUP_COUNTER_RATIO = 0.05;
const CATCHUP_COUNTER_MAG   = 1;

// N개 슬롯 중 K개 균등 + jitter 픽 (인덱스 0 제외 — 첫 이벤트 앞 휴식 무의미).
function pickEvenSlots(n: number, k: number, rng: () => number): Set<number> {
  const out = new Set<number>();
  if (k <= 0 || n <= 1) return out;
  const span = n - 1;
  const step = span / k;
  for (let i = 0; i < k; i++) {
    const center = 1 + step * i + step / 2;
    const jitter = (rng() - 0.5) * step;
    const idx = Math.round(center + jitter);
    out.add(Math.max(1, Math.min(n - 1, idx)));
  }
  return out;
}

// catch-up 전용 빌더 (2026-06-08, 사용자 피드백).
// 사이클(=1시간)에 묶이지 않는다. 기본 intervalMs(=3초) 고정 간격에 휴식/감소
// 슬롯을 섞어 큰 갭 채널이 1초당 1회씩 쉬지 않고 올라가던 문제를 막는다.
//
// 구조:
//   - 추세 슬롯 T = ceil((absNet + C) / maxMag), 합 = absNet + C
//   - 감소 슬롯 C ≤ T × 5/95 (전체의 5% 이내), 각 ±1
//   - 휴식 슬롯 R ≤ N × 10% (N=T+C), 각 슬롯 직전에 0.5~2초 추가 지연
//   - Σ magnitude === netDelta (감소분 추세가 흡수)
//   - |각 magnitude| ≤ maxMagnitude
//
// 갭이 작은 채널(absNet ≤ maxMag×~19)은 C=0, R=0이라 순수 i×interval 페이스.
export function buildCatchUpEvents(opts: BuildCatchUpOpts): ScheduledEvent[] {
  const rng = opts.rng ?? defaultRng;
  const absNet = Math.abs(opts.netDelta);
  if (absNet === 0) return [];
  const trendDir = opts.netDelta > 0 ? 1 : -1;
  const maxMag = opts.maxMagnitude;

  // T, C 동시 결정 — C/(T+C) ≤ counterRatio. 평형: C = floor(T × r/(1-r)),
  // T = max(추세_충족_최소, 다양화). 단조 증가 → 3회면 안정.
  //
  // 다양화 항(2026-06-08 customer feedback): T_diverse = ceil(absNet / (maxMag × 0.7))
  // 으로 슬롯을 부풀려 distributeRandom의 variance 폭이 충분히 열린다. 그렇지
  // 않으면 T = ceil(absNet/maxMag)에서 avg = maxMag − ε이 되어 모든 슬롯이
  // maxMag로 클램프(=catch-up이 +40만 연속 출력하는 문제).
  const cFactor = CATCHUP_COUNTER_RATIO / (1 - CATCHUP_COUNTER_RATIO);
  let T = Math.max(1, Math.ceil(absNet / (maxMag * 0.7)));
  let C = 0;
  for (let i = 0; i < 3; i++) {
    C = Math.floor(T * cFactor);
    const trendTotal = absNet + C * CATCHUP_COUNTER_MAG;
    T = Math.max(
      Math.ceil(trendTotal / maxMag),         // 합 충족 최소
      Math.ceil(trendTotal / (maxMag * 0.7)), // 다양화
    );
  }

  // 추세 합 = absNet + C×counterMag (감소분 흡수). 1~maxMag로 무작위 분배.
  const trendTotal = absNet + C * CATCHUP_COUNTER_MAG;
  const trendMags = shuffle(distributeRandom(trendTotal, T, maxMag, rng), rng)
    .map((m) => trendDir * m);
  const counterMags = Array<number>(C).fill(-trendDir * CATCHUP_COUNTER_MAG);
  const merged = interleave(trendMags, counterMags);
  const N = merged.length;

  // 휴식 슬롯 — 무작위 균등 분포 + jitter, 각 0.5~2초 추가 지연.
  const R = Math.floor(N * CATCHUP_REST_RATIO);
  const restSlots = pickEvenSlots(N, R, rng);
  const restSpan = CATCHUP_REST_MAX_MS - CATCHUP_REST_MIN_MS + 1;

  const events: ScheduledEvent[] = [];
  let cursor = 0;
  for (let i = 0; i < N; i++) {
    if (restSlots.has(i)) {
      cursor += CATCHUP_REST_MIN_MS + Math.floor(rng() * restSpan);
    }
    events.push({ offsetMs: cursor, magnitude: merged[i]! });
    cursor += opts.intervalMs;
  }
  return events;
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
