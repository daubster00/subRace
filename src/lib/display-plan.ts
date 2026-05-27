import { getApiBucket } from './api-bucket';

// M4 display-planner의 순수 결정 함수들.
// DB 접근 없음 → 단위 테스트 가능. worker/display-planner.ts가 이걸 조립해서
// 채널별 plan을 만든다.

export type Tier = 'exposed' | 'waiting';

// 채널 규모별 1회 변경 단위. 모든 규모에서 상한 100 이하로 — 그 이상이면
// 클라이언트 interpolation hook이 한 polling cycle 안에 따라잡으려고 빠른
// 카운트업처럼 보여 부자연스럽다.
// planner는 직접 쓰지 않고 decideChangeCount의 분모로만 사용 — 이벤트별 실제
// step magnitude는 M5 executor가 다시 산정.
export function getStepBounds(api: number): { min: number; max: number } {
  if (api < 100_000) return { min: 1, max: 3 };
  if (api < 1_000_000) return { min: 2, max: 10 };
  if (api < 10_000_000) return { min: 5, max: 30 };
  return { min: 10, max: 80 };
}

// step magnitude를 줄인 만큼 빈도를 늘려 같은 today_delta를 분산 처리.
// exposed 720 = 자정~자정 평균 2분 간격. waiting 240 = 평균 6분 간격.
export function getChangeCountBounds(tier: Tier): { min: number; max: number } {
  if (tier === 'exposed') return { min: 30, max: 720 };
  return { min: 10, max: 240 };
}

// 노출 진입 가능 buffer까지 'exposed'로 친다 (스펙 L315, active_plan).
export function decideTier(rank: number, displayLimit: number, bufferSize: number): Tier {
  return rank <= displayLimit + bufferSize ? 'exposed' : 'waiting';
}

// expected_daily_delta가 null일 때 (3개 미만 마일스톤 행 등) fallback rate.
// interpolation.ts STAGNANT_RATE_DIVISOR 패턴: 60일 동안 bucket.unit/2 증가 가정.
// daily_delta = bucket.unit / (60 × 2) = bucket.unit / 120.
export function getFallbackDailyDelta(api: number): number {
  const { unit } = getApiBucket(api);
  return unit / (60 * 2);
}

export interface TargetAndDelta {
  target: number;
  todayDelta: number;
}

// 오늘 목표값과 부호 있는 delta.
//   delta ≥ 0: target = min(display + delta, cap)
//   delta < 0: target = max(display + delta, api) ← api가 자연 하한
// API 값 자체가 감소해 display > api인 경우엔 max(display+delta, api)가
// api까지 내려갈 여지를 준다 (스펙 L269).
export function computeTargetAndDelta(opts: {
  display: number;
  api: number;
  cap: number;
  expectedDailyDelta: number;
}): TargetAndDelta {
  const { display, api, cap, expectedDailyDelta } = opts;
  if (expectedDailyDelta >= 0) {
    const raw = display + expectedDailyDelta;
    const target = Math.min(raw, cap);
    return { target, todayDelta: target - display };
  }
  const raw = display + expectedDailyDelta;
  const target = Math.max(raw, api);
  return { target, todayDelta: target - display };
}

// 채널 tier + |today_delta| + 채널 규모로 하루 변경 횟수 결정.
//
// 기본 아이디어: 평균 step 크기로 |delta|를 나누면 "필요 이벤트 수" 추정. 거기에
// tier 범위 [min,max]로 clamp하고 ±20% 랜덤 흔들기.
//
// |delta|가 매우 작은 채널(이미 cap 근처 / 정체)도 tier.min 만큼은 이벤트가
// 돌아 화면이 멈춰 보이지 않게 한다 → executor가 자연스러운 흔들림 처리.
export function decideChangeCount(opts: {
  todayDelta: number;
  stepBounds: { min: number; max: number };
  tier: Tier;
  rng?: () => number;
}): number {
  const rng = opts.rng ?? Math.random;
  const tierBounds = getChangeCountBounds(opts.tier);
  const meanStep = Math.max(1, (opts.stepBounds.min + opts.stepBounds.max) / 2);
  const needed = Math.abs(opts.todayDelta) / meanStep;
  const raw = Math.round(needed);
  const clamped = Math.max(tierBounds.min, Math.min(tierBounds.max, raw));
  const jitter = 0.8 + rng() * 0.4;
  return Math.max(tierBounds.min, Math.min(tierBounds.max, Math.round(clamped * jitter)));
}

// 첫 변경 이벤트까지의 ms. 평균 = 남은 시간 / 남은 횟수, ±jitterRatio 랜덤.
// MIN_INTERVAL_MS 하한은 폴링 빈도 이하로 떨어지는 걸 방지.
export const MIN_INTERVAL_MS = 60_000;

export function pickFirstIntervalMs(opts: {
  remainingMs: number;
  remainingChanges: number;
  jitterRatio: number;
  rng?: () => number;
}): number {
  const rng = opts.rng ?? Math.random;
  if (opts.remainingChanges <= 0) {
    return Math.max(MIN_INTERVAL_MS, opts.remainingMs);
  }
  const mean = opts.remainingMs / opts.remainingChanges;
  const low = mean * (1 - opts.jitterRatio);
  const high = mean * (1 + opts.jitterRatio);
  const v = low + rng() * (high - low);
  return Math.max(MIN_INTERVAL_MS, Math.round(v));
}

export interface ShouldReplanInput {
  display: { plan_date: string; updated_at: string } | null;
  poll: { last_api_changed_at: string | null };
  jstToday: string;
}

// 재계획 조건 (active_plan §M4):
//   (a) display 없음 — 신규 채널 첫 진입
//   (b) plan_date != today — JST 자정 리셋
//   (c) poll.last_api_changed_at > display.updated_at — mid-day API 변경
export function shouldReplan({ display, poll, jstToday }: ShouldReplanInput): boolean {
  if (!display) return true;
  if (display.plan_date !== jstToday) return true;
  if (poll.last_api_changed_at) {
    const changed = new Date(poll.last_api_changed_at).getTime();
    const updated = new Date(display.updated_at).getTime();
    if (changed > updated) return true;
  }
  return false;
}
