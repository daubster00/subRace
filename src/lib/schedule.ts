// 사전 스케줄 이벤트 생성 — 순수 함수 (DB·시간 의존 없음, rng 주입 가능).
//
// 한 채널의 1시간 사이클에 대해 (시각 offset, 부호 있는 magnitude) 이벤트 배열을
// 만든다. 핵심 불변식:
//   1. Σ magnitude ≈ netDelta              (정규 분배는 정확히, 적응 분배는 ±0~1 오차)
//   2. |각 magnitude| ≤ MAG_HARD_MAX        (큰 absNet일 때 MAG_HARD_MAX 동적 증가)
//   3. 인접 이벤트 간격 ≥ MIN_EVENT_INTERVAL_MS — 화면 모션이 한 번씩 완주.
//   4. 작은 absNet 채널도 N(이벤트 개수)이 N_MIN_RANGE 이상 보장 — 시각적 활발.

// ─────────────────────────────────────────────────────────────────────────────
// 상수 정의 (2026-06-09 customer feedback, plan 문서 참조)
// ─────────────────────────────────────────────────────────────────────────────

// 클라 모션 길이(MOTION_TOTAL_DURATION_MS, useInterpolatedSnapshot.ts와 동기)
// + 모션 사이 시각적 휴식 ≈ 2초. 이보다 짧은 간격으로 이벤트가 박히면 직전
// 모션이 끝나기 전에 새 모션이 시작돼 메트로놈처럼 보임.
export const MIN_EVENT_INTERVAL_MS = 6_200;

// 1시간 사이클에 들어갈 수 있는 이벤트의 물리적 상한.
// = floor(3,600,000 ÷ MIN_EVENT_INTERVAL_MS)
const N_PHYS_MAX = 580;

// 작은 absNet 채널의 N(이벤트 개수) 보장 범위.
// absNet < SMALL_ABSNET_THRESHOLD면 [N_MIN_RANGE, N_MAX_RANGE] 사이 랜덤.
// 2026-06-09 CF-11: N_MIN 175→100. N=100이면 슬롯 간격 36초 — 이벤트가
// 덜 빈번하게 발생해 잔잔한 채널의 시각적 평온함을 더 강하게 보장.
// export: schedule-plan이 적응 분배 진입 영역 판단(=마일스톤 도달 catch-up
// 트리거)에도 같은 임계를 쓰기 위함(2026-06-11 CF-17).
export const SMALL_ABSNET_THRESHOLD = 1_160;
const N_MIN_RANGE = 100;
const N_MAX_RANGE = 300;

// 큰 absNet 케이스의 이벤트당 평균 목표 magnitude (= MAG_HARD_MAX / 2).
// N = round(absNet / TARGET_MAG). 평균이 중간값이 되도록 설계.
const TARGET_MAG = 5;

// magHardMax 동적 증가의 절대 상한 (2026-06-09 CF-12). N이 N_PHYS_MAX에 캡되어
// 평균 magnitude가 기본 maxMagnitude의 절반(=5)을 넘으면 magHardMax를
// round(2×avg)로 올려 다양화를 회복하되, 이 상한을 넘지 않도록 묶는다.
// → 극단 absNet(예: overdue 클램프 재발)에서도 단일 이벤트 ≤ 30 보장. absNet이
// 580×30/2=8700을 넘으면 한 사이클에 절대 다 못 닫지만, 사용자 시각상 ±30
// 이내의 점프가 우선이라는 결정(CF-9 후속).
const MAG_HARD_MAX_CAP = 30;

// 빈 슬롯 회피 임계: absNet < EMPTY_SLOT_THRESHOLD_RATIO × N이면 적응 분배.
// 정규 분배에서 (absNet + counterTotal) / nTrend < 1이 되는 지점 = 0.8N.
const EMPTY_SLOT_THRESHOLD_RATIO = 0.8;

// 정규 분배에서 감소 슬롯이 차지하는 비율 = N의 10%.
const COUNTER_SLOT_RATIO = 0.10;
// 감소 한 번당 magnitude. "내려가는 것처럼만 보이게" 1.
const COUNTER_MAG = 1;

// 적응 분배(작은 absNet) 슬롯당 magnitude 절대값 범위.
// 모든 슬롯이 ±1 고정이던 걸 ±1~5 균등 랜덤으로 변경(2026-06-09 CF-10).
// 평균값(3)으로 P/Q를 재산출해 합 기댓값이 absNet이 되게 한다.
const SMALL_ADAPTIVE_MAX_MAG = 5;
const SMALL_ADAPTIVE_AVG_MAG = (1 + SMALL_ADAPTIVE_MAX_MAG) / 2;

// 진동(bounce) 이벤트 한 개의 magnitude 절대값 범위 [1, MAX].
// 부호는 amplitude(±amp) 안에 들어오는 쪽으로 자동 결정. 양쪽 다 가능하면 랜덤.
// 2026-06-09 CF-10: 기존 -10~+10 균등에서 |mag|=1~5 랜덤으로 변경(0 박힘 제거).
export const BOUNCE_PER_EVENT_MAGNITUDE = 5;

// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduledEvent {
  offsetMs: number;  // 사이클 시작으로부터의 ms. [0, cycleMs)
  magnitude: number; // 부호 있음. + 증가 / − 감소
}

function defaultRng(): number {
  return Math.random();
}

// total을 n개 정수로 분배. 각 ∈ [1, maxEach]. 합 정확히 total.
//   분포 방식: 평균 avg = total/n 중심으로 ±variance 흔든 뒤 클램프, 잔차는
//   무작위 슬롯에 ±1로 흡수.
function distributeRandom(
  total: number,
  n: number,
  maxEach: number,
  rng: () => number,
): number[] {
  if (n <= 0) return [];
  const minEach = 1;
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
  const variance = Math.min(avg - minEach, maxEach - avg) * 0.8;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = Math.round(avg + (rng() - 0.5) * 2 * variance);
    out.push(Math.max(minEach, Math.min(maxEach, v)));
  }

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

// N개 슬롯 중 K개를 무작위로 선택 (중복 없음). 균등 X — 진짜 랜덤.
function pickRandomSlots(n: number, k: number, rng: () => number): Set<number> {
  const out = new Set<number>();
  if (k <= 0 || n <= 0) return out;
  const indices = Array.from({ length: n }, (_, i) => i);
  const pickCount = Math.min(k, n);
  for (let i = 0; i < pickCount; i++) {
    const idx = Math.floor(rng() * indices.length);
    out.add(indices.splice(idx, 1)[0]!);
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

// 부호 있는 magnitude 슬롯 배열에 시각을 부여. 균등 분배 + ±jitter + 채널 위상.
//
// jitter 폭은 두 제약 중 작은 쪽으로 클램프:
//   (a) 원래 jitterRatio 기반 폭        = jitterRatio × slot / 2
//   (b) 인접 간격 ≥ MIN_EVENT_INTERVAL_MS 보장 폭 = max(0, (slot − MIN) / 2)
// 슬롯이 빠듯할수록(MIN에 가까울수록) jitter는 0에 수렴.
//
// 채널별 phaseShift: 같은 N이 캡된 채널들이 같은 시각에 일제 발화하는 lock-step
// 동기화 방지. slot = cycleMs/N이므로 모듈로 wrap이 슬롯 간격을 보존
// (인접 슬롯 간격 = slot, 마지막 wrap 슬롯과 첫 슬롯 사이도 slot).
function assignTimes(
  magnitudes: number[],
  cycleMs: number,
  jitterRatio: number,
  rng: () => number,
  opts: { phaseShift?: boolean } = {},
): ScheduledEvent[] {
  const n = magnitudes.length;
  const slot = cycleMs / n;
  const safeJitterMax = Math.max(0, (slot - MIN_EVENT_INTERVAL_MS) / 2);
  const rawJitterMax = (jitterRatio * slot) / 2;
  const jitterMax = Math.min(rawJitterMax, safeJitterMax);
  // phaseShift는 채널 간 동시 발화 desync용 — events를 cyclic shift하여 정렬 후
  // 순서가 회전됨. 단방향 bounce(감소 채널)는 이 회전이 누적 위치를 [0, posCap]
  // 밖으로 끌어내릴 수 있어 호출자가 false로 끌 수 있다.
  const usePhaseShift = opts.phaseShift !== false;
  const phaseShift = usePhaseShift ? rng() * cycleMs : 0;
  const events: ScheduledEvent[] = magnitudes.map((magnitude, i) => {
    const jitter = (rng() - 0.5) * 2 * jitterMax;
    const raw = i * slot + slot / 2 + jitter + phaseShift;
    const offsetMs = ((Math.round(raw) % cycleMs) + cycleMs) % cycleMs;
    return { offsetMs, magnitude };
  });
  events.sort((a, b) => a.offsetMs - b.offsetMs);
  return events;
}

export interface BuildCycleOpts {
  netDelta: number;       // 이 사이클의 목표 순변화량 (부호 있음)
  cycleMs: number;        // 사이클 길이 (보통 1시간 = 3,600,000ms)
  maxMagnitude: number;   // 이벤트당 절대 상한 기본값 (보통 10). 큰 absNet일 때 내부에서 동적 증가
  jitterRatio: number;    // 시각 jitter 비율 (0~1)
  rng?: () => number;
}

// Normal phase 사이클 — 자네 의도 알고리즘 (2026-06-09 CF-8 재설계, plan 문서 §알고리즘).
//
// Step 1: N(이벤트 개수) 결정
//   absNet < SMALL_ABSNET_THRESHOLD(1160) → random([100, 300])
//   absNet ≥ 1160                        → round(absNet / TARGET_MAG=5), N_PHYS_MAX=580 캡
//
// Step 2: MAG_HARD_MAX 동적 조정 (N이 N_PHYS_MAX에 캡됐을 때만)
//   absNet > 580 × 10 = 5,800 → MAG_HARD_MAX = round(2 × absNet / N)
//
// Step 3+4: 분기 분배
//   absNet < 0.8 × N → 적응 분배 (모든 ±1, 빈 슬롯 없음)
//   else            → 정규 분배 (10% 감소, 추세는 distributeRandom 다양화)
//
// Step 5: 시각 배치 (assignTimes — uniform + jitter + phaseShift + wrap)
export function buildCycleEvents(opts: BuildCycleOpts): ScheduledEvent[] {
  const rng = opts.rng ?? defaultRng;
  const { cycleMs, jitterRatio } = opts;
  const trendDir = opts.netDelta >= 0 ? 1 : -1;
  const absAbsNet = Math.abs(opts.netDelta);
  if (absAbsNet === 0) return [];

  // Step 1: N 결정
  let N: number;
  if (absAbsNet < SMALL_ABSNET_THRESHOLD) {
    N = N_MIN_RANGE + Math.floor(rng() * (N_MAX_RANGE - N_MIN_RANGE + 1));
  } else {
    N = Math.round(absAbsNet / TARGET_MAG);
    if (N > N_PHYS_MAX) N = N_PHYS_MAX;
  }

  // Step 2: MAG_HARD_MAX 동적 조정. 2026-06-09 CF-12: 트리거 조건을
  // "평균 magnitude > magHardMax/2"로 완화 (이전: N 캡 + absNet > N×maxMag).
  // 이전 조건은 평균이 maxMagnitude 가까이 붙어도 동적 증가가 안 돼 분포가
  // 9~10에 몰리는 단조 문제 발생 (TAIKISLIFE 사례). 새 조건은 평균이 항상
  // magHardMax/2 부근이 되도록 유지해 distributeRandom의 variance 폭을 확보.
  // 단 MAG_HARD_MAX_CAP(=30) 상한으로 단일 이벤트 점프를 시각적 한도 안에 가둠.
  let magHardMax = opts.maxMagnitude;
  const avgMag = absAbsNet / N;
  if (avgMag > magHardMax / 2) {
    magHardMax = Math.min(MAG_HARD_MAX_CAP, Math.round(2 * avgMag));
  }

  // Step 3+4: 분배 분기
  let merged: number[];
  if (absAbsNet < EMPTY_SLOT_THRESHOLD_RATIO * N) {
    // 적응 분배: absNet이 너무 작아 정규 분배 시 빈 슬롯 발생.
    // 모든 슬롯에 |mag|=1~5 균등 랜덤(빈 슬롯 없음, 단조 ±1보다 자연).
    //   P(추세 슬롯) - Q(감소 슬롯) = absNet / AVG_MAG, P + Q = N
    //   → P = (N + absNet/AVG_MAG) / 2
    // 합 기댓값 = (P−Q) × AVG_MAG = absNet. 실제 합은 슬롯별 랜덤 편차로
    // ±√N×stddev 정도 흔들리고 다음 사이클 plan이 자연 보정.
    const diff = Math.round(absAbsNet / SMALL_ADAPTIVE_AVG_MAG);
    const P = Math.max(0, Math.min(N, Math.round((N + diff) / 2)));
    const Q = N - P;
    const counterPositions = pickRandomSlots(N, Q, rng);
    merged = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      const absMag = 1 + Math.floor(rng() * SMALL_ADAPTIVE_MAX_MAG);
      merged[i] = counterPositions.has(i) ? -trendDir * absMag : trendDir * absMag;
    }
  } else {
    // 정규 분배: 10% 감소 + 추세 슬롯은 다양 magnitude.
    const nCounter = Math.round(N * COUNTER_SLOT_RATIO);
    const nTrend = N - nCounter;
    const counterTotal = nCounter * COUNTER_MAG;
    const trendTotal = absAbsNet + counterTotal;
    const trendMags = shuffle(
      distributeRandom(trendTotal, nTrend, magHardMax, rng),
      rng,
    ).map((m) => trendDir * m);
    // 감소 슬롯 위치 — 무작위 분포.
    const counterPositions = pickRandomSlots(N, nCounter, rng);
    merged = new Array<number>(N);
    let ti = 0;
    for (let i = 0; i < N; i++) {
      if (counterPositions.has(i)) {
        merged[i] = -trendDir * COUNTER_MAG;
      } else {
        merged[i] = trendMags[ti++]!;
      }
    }
  }

  // Step 5: 시각 배치
  return assignTimes(merged, cycleMs, jitterRatio, rng);
}

export interface BuildCatchUpOpts {
  netDelta: number;       // 따라잡을 순변화 (부호 있음)
  intervalMs: number;     // 이벤트 사이 고정 간격 (기본 5000ms)
  maxMagnitude: number;   // 이벤트당 절대 상한 (기본 40)
  rng?: () => number;
}

// catch-up 자연스러움 파라미터 (2026-06-11 customer feedback, CF-18).
//   PAUSE_AFTER_RUN : 같은 방향 연속 이벤트 N개 박은 직후 다음 슬롯까지 +EXTRA_MS
//                     (intervalMs=5초 위에 8초 추가 → 13초 간격). PAUSE 카운터 리셋.
//   COUNTER_AFTER_RUN: 같은 방향 연속 이벤트 N개 박은 직후 다음 슬롯에 단일 역방향
//                      이벤트 (mag 절댓값=1~5 균등). 두 카운터 모두 리셋.
//   PAUSE_RUN=4, COUNTER_RUN=10이라 LCM=20까지 동시 발동 없음 — 첫 충돌 시점엔
//   역방향이 휴식 효과를 겸하므로 8초 쉼은 생략(역방향만 적용).
const CATCHUP_PAUSE_AFTER_RUN  = 4;
const CATCHUP_PAUSE_EXTRA_MS   = 8_000;
const CATCHUP_COUNTER_AFTER_RUN = 10;
const CATCHUP_COUNTER_MIN_MAG  = 1;
const CATCHUP_COUNTER_MAX_MAG  = 5;

// catch-up 전용 빌더 (2026-06-11 CF-18 재설계).
// 사이클(=1시간)에 묶이지 않는다. 기본 intervalMs(=5초) 고정 간격으로 추세 이벤트를
// 박되, 같은 방향 연속 길이에 따라 두 가지 자연스러움 장치를 삽입.
//
//   1) 4번 연속 박으면 → 다음 슬롯까지 +8초 추가 (5+8=13초 간격). PAUSE 카운터 리셋.
//   2) 10번 연속 박으면 → 다음 슬롯에 단일 역방향 이벤트(|mag|=1~5 균등) 삽입.
//      삽입 후 두 카운터 모두 리셋(역방향이 방향을 깨므로).
//
// 두 카운터 동시 발동 시점(20, 40, …번째)에는 역방향만 적용, 8초 쉼은 생략 — 역방향
// 이벤트 자체가 시각적 휴식 역할.
//
//   - Σ magnitude === netDelta (역방향 절댓값만큼 추세 슬롯 총량을 늘려 흡수)
//   - |각 magnitude| ≤ maxMagnitude
export function buildCatchUpEvents(opts: BuildCatchUpOpts): ScheduledEvent[] {
  const rng = opts.rng ?? defaultRng;
  const absNet = Math.abs(opts.netDelta);
  if (absNet === 0) return [];
  const trendDir = opts.netDelta > 0 ? 1 : -1;
  const maxMag = opts.maxMagnitude;

  // 1) 추세 슬롯 수 T를 절댓값 합이 (absNet + 역방향 누적)을 만족하도록 결정.
  //    역방향 1개당 평균 절댓값 = (MIN+MAX)/2 = 3. T가 늘면 역방향도 늘어 trendTotal
  //    이 또 늘어남 → 2~3회 iteration으로 수렴.
  const avgCounterMag = (CATCHUP_COUNTER_MIN_MAG + CATCHUP_COUNTER_MAX_MAG) / 2;
  let T = Math.max(1, Math.ceil(absNet / maxMag));
  let counterCount = 0;
  for (let i = 0; i < 3; i++) {
    counterCount = Math.floor(T / CATCHUP_COUNTER_AFTER_RUN);
    const estimatedTrendTotal = absNet + counterCount * avgCounterMag;
    T = Math.max(1, Math.ceil(estimatedTrendTotal / maxMag));
  }

  // 2) 역방향 magnitude 미리 결정 (1~5 균등). 절댓값 합 결정 → 추세 총량 확정.
  const counterAbsMags: number[] = [];
  let counterAbsSum = 0;
  for (let i = 0; i < counterCount; i++) {
    const x = CATCHUP_COUNTER_MIN_MAG +
      Math.floor(rng() * (CATCHUP_COUNTER_MAX_MAG - CATCHUP_COUNTER_MIN_MAG + 1));
    counterAbsMags.push(x);
    counterAbsSum += x;
  }
  const trendTotal = absNet + counterAbsSum;
  // 추세 슬롯이 trendTotal을 ≤ maxMag로 담아낼 수 있도록 T 보정 (counterCount는 위에서
  // 평균 기준이라 실제 합이 살짝 흔들릴 수 있음).
  if (T * maxMag < trendTotal) T = Math.ceil(trendTotal / maxMag);

  const trendAbsMags = shuffle(distributeRandom(trendTotal, T, maxMag, rng), rng);

  // 3) emit — 추세를 순서대로 박고, 4·10 카운터에 따라 쉼/역방향 삽입.
  const events: ScheduledEvent[] = [];
  let cursor = 0;
  let runPause = 0;
  let runCounter = 0;
  let counterIdx = 0;
  for (let i = 0; i < T; i++) {
    events.push({ offsetMs: cursor, magnitude: trendDir * trendAbsMags[i]! });
    cursor += opts.intervalMs;
    runPause++;
    runCounter++;

    if (runCounter >= CATCHUP_COUNTER_AFTER_RUN && counterIdx < counterAbsMags.length) {
      // 역방향 단일 이벤트 (휴식 효과 겸함, 8초 쉼은 적용 안 함)
      events.push({ offsetMs: cursor, magnitude: -trendDir * counterAbsMags[counterIdx++]! });
      cursor += opts.intervalMs;
      runPause = 0;
      runCounter = 0;
    } else if (runPause >= CATCHUP_PAUSE_AFTER_RUN) {
      // 다음 슬롯까지 추가 휴식
      cursor += CATCHUP_PAUSE_EXTRA_MS;
      runPause = 0;
    }
  }

  return events;
}

export interface BuildBounceOpts {
  amplitude: number;   // 진동 가능 범위(±). 디스플레이가 target ± amplitude 내에 머무름.
  count: number;       // 이벤트 수
  cycleMs: number;
  jitterRatio: number;
  rng?: () => number;
  // 비대칭 진동(2026-06-10): pos가 [-negCap, +posCap] 안에 머문다. 둘 다 미지정이면
  // posCap=negCap=amplitude로 양방향 동작(기존 호출자 호환). 감소 채널의 단방향
  // 진동은 negCap=0 + startPos=0으로 호출해 latest 아래로 못 내려가게 한다.
  posCap?: number;
  negCap?: number;
  startPos?: number;
}

// target 도달 후 진동 (target-bounce). 각 step의 |mag|=1~5 균등 랜덤이고
// 부호는 누적 pos가 [-negCap, +posCap] 안에 머물도록 자동 결정 — 양 부호 다 가능하면
// 50/50 랜덤, 한쪽만 가능하면 그 쪽 강제. 가능하면 0은 박지 않는다.
// 종료 시 누적이 정확히 0으로 돌아오지 않을 수 있음 — 다음 사이클의 plan이
// 새 gap으로 자연스럽게 보정.
export function buildBounceEvents(opts: BuildBounceOpts): ScheduledEvent[] {
  const rng = opts.rng ?? defaultRng;
  const amp = Math.max(1, Math.round(opts.amplitude));
  const posCap = Math.max(0, Math.round(opts.posCap ?? amp));
  const negCap = Math.max(0, Math.round(opts.negCap ?? amp));
  const maxEach = BOUNCE_PER_EVENT_MAGNITUDE;
  const n = Math.max(2, opts.count);

  const mags: number[] = [];
  let pos = Math.round(opts.startPos ?? 0);
  for (let i = 0; i < n; i++) {
    const posRoom = posCap - pos;     // 위로 갈 여유
    const negRoom = negCap + pos;     // 아래로 갈 여유
    const absMag = 1 + Math.floor(rng() * maxEach); // 1~maxEach
    const posCapped = Math.min(absMag, posRoom);
    const negCapped = Math.min(absMag, negRoom);
    let mag: number;
    if (posCapped >= 1 && negCapped >= 1) {
      mag = rng() < 0.5 ? posCapped : -negCapped;
    } else if (posCapped >= 1) {
      mag = posCapped;
    } else if (negCapped >= 1) {
      mag = -negCapped;
    } else {
      mag = 0;
    }
    mags.push(mag);
    pos += mag;
  }

  // 비대칭(단방향) bounce면 phaseShift 끄기 — 시간순 정렬 시 mags 회전이 일어나
  // [0, posCap] 안전 구간을 벗어날 수 있음.
  const asymmetric = posCap !== negCap;
  return assignTimes(mags, opts.cycleMs, opts.jitterRatio, rng, {
    phaseShift: !asymmetric,
  });
}
