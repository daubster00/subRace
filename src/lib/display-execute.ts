import { getStepBounds } from './display-plan';

// M5 display-executor의 순수 결정 함수들.
// DB 접근 없음 → 단위 테스트 가능. worker/display-executor.ts가 이걸 조립해
// next_change_at 도래 채널의 display_subscriber_count를 갱신한다.

export type Direction = 'up' | 'down';

// today_delta 부호로 우세 방향을 정하고, bias range 안에서 그 우세 확률 자체를
// 다시 흔든 뒤 코인 토스. planner의 today_delta가 +면 up이 평균 75~90% 확률로,
// −면 down이 60~85% 확률로 나오게 된다 (스펙 L282~290).
//
// 양쪽 모두 100%로 한쪽으로 쏠리지 않게 해서, 추세 안에서도 자연스러운 흔들림을
// 둔다. todayDelta = 0이면 up bias로 처리(상승 추세 fallback).
export function decideDirection(opts: {
  todayDelta: number;
  upMin: number;
  upMax: number;
  downMin: number;
  downMax: number;
  rng?: () => number;
}): Direction {
  const rng = opts.rng ?? Math.random;
  const positive = opts.todayDelta >= 0;
  const pMin = positive ? opts.upMin : opts.downMin;
  const pMax = positive ? opts.upMax : opts.downMax;
  const p = pMin + rng() * (pMax - pMin);
  const dominant: Direction = positive ? 'up' : 'down';
  const opposite: Direction = positive ? 'down' : 'up';
  return rng() < p ? dominant : opposite;
}

// getStepBounds [min, max] 정수 균등 분포. max+1로 상한 포함.
export function pickStepMagnitude(api: number, rng: () => number = Math.random): number {
  const { min, max } = getStepBounds(api);
  return Math.floor(min + rng() * (max - min + 1));
}

export interface ApplyStepResult {
  display: number;
  delta: number; // 부호 있는 실제 변화량(경계 클램프 반영)
}

// direction에 따라 display ± magnitude, cap(위) / api(아래) 경계 클램프.
// 이미 경계에 붙어 있으면 delta = 0이 나올 수 있다 — 호출 측은 그래도
// applied_change_count는 +1 해서 이벤트 슬롯을 소진시킨다.
export function applyStep(opts: {
  display: number;
  direction: Direction;
  magnitude: number;
  api: number;
  cap: number;
}): ApplyStepResult {
  if (opts.direction === 'up') {
    const next = Math.min(opts.display + opts.magnitude, opts.cap);
    return { display: next, delta: next - opts.display };
  }
  const next = Math.max(opts.display - opts.magnitude, opts.api);
  return { display: next, delta: next - opts.display };
}
