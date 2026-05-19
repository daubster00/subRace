import { clampToBucket, getApiBucket } from './api-bucket';

// 마일스톤 기반 구독자 수 추정.
//
// 모델:
//   1. 60일 milestone에서 도출된 growthRatePerHour로 시간당 자연 증가/감소.
//   2. 폴링 시점 (polledCount) 기준으로 rate × elapsedSeconds 누적.
//   3. cap = "다음 마일스톤(=현재 API bucket 다음 경계)의 safetyRatio 위치".
//      - 양의 성장: bucket.floor + safetyRatio × unit (예: 85% 위치)
//      - 음의 성장: bucket.floor + (1 - safetyRatio) × unit (예: 15% 위치)
//   4. cap 도달 후엔 cap을 중심으로 ±OSCILLATION_AMPLITUDE_RATIO × unit 만큼
//      사인 곡선으로 흔들리며 머무름. 정지하지 않음.
//   5. 폴링 간격(YOUTUBE_POLL_INTERVAL_HOURS)과는 무관. 운영자가 5분이든
//      6시간이든 변경해도 추정 폭은 채널의 60일 페이스에만 의존.

export interface InterpolateParams {
  sPrev: number | null;
  sCurr: number;
  tInterval: number;
  t: number;
  safetyRatio: number;
}

// PRD §4.4 (F-9)의 원래 보간 함수. 일부 테스트가 의존하기 때문에 유지.
// 신규 코드는 estimateSubscriberCount를 사용해야 한다.
export function interpolate({ sPrev, sCurr, tInterval, t, safetyRatio }: InterpolateParams): number {
  if (sPrev === null || t === 0) return sCurr;

  const r = (sCurr - sPrev) / tInterval;
  if (r === 0) return sCurr;

  const sPredicted = sCurr + r * tInterval;
  const sSafe = sCurr + safetyRatio * (sPredicted - sCurr);
  const linear = sCurr + r * t;

  return r > 0 ? Math.min(linear, sSafe) : Math.max(linear, sSafe);
}

export interface EstimateParams {
  polledCount: number;
  // 시간당 성장 (음수면 감소). null이면 추정 불가 → polledCount 그대로.
  growthRatePerHour: number | null;
  // 마지막 폴링 이후 경과 시간 (초).
  elapsedSeconds: number;
  // 다음 마일스톤 중 어느 위치를 cap으로 잡을지 (0~1). 기본 0.85.
  safetyRatio: number;
}

// cap 부근 oscillation 파라미터.
// 진폭: bucket.unit의 ±10%. 양의 성장은 [75%, 95%] 위치, 음의 성장은 [5%, 25%]
// 위치에서 흔들림 → bucket 침범 없음.
const OSCILLATION_AMPLITUDE_RATIO = 0.10;
// 사인 곡선 한 주기. 결정론적이라 페이지를 새로고침해도 elapsedSeconds로
// phase가 일관되게 결정됨.
const OSCILLATION_PERIOD_SECONDS = 600;

// rate=null/0인 채널에 부여할 최소 성장률.
//
// 의미: 60일 milestone과 현재 폴링값이 같은 API bucket인 경우, 채널이 60일
// 동안 [0, bucket.unit) 사이로 늘었지만 정확한 값을 모름. 평균을 잡으면
// bucket.unit × 0.5. 그래서 시간당 rate ≈ bucket.unit / (60일 × 24h) / 2
// = bucket.unit / 2880.
//
// 이건 측정 불가능한 채널이 화면에서 완전히 정지해 보이는 걸 막는 임시 가정.
// 시간이 지나 60일 milestone에 실제 데이터가 쌓이면 자연스럽게 진짜 rate로 대체됨.
const STAGNANT_RATE_DIVISOR = 60 * 24 * 2;

// 폴링 간격에 의존하지 않는 마일스톤 기반 추정값.
//
// 양의 성장 채널 예시 (ISSEI 75.4M, rate=1916/h):
//   - bucket = [75_400_000, 75_500_000), unit = 100_000
//   - capPosition = 75_485_000 (85% 위치)
//   - 도달 시간 = 85_000 / 1916 ≈ 44.4시간
//   - 그 전엔 linear 자연 누적, 그 후엔 75_485_000 ± 10_000 (=±10% unit) 흔들림
//   - 폴링 간격이 5분이든 6시간이든 cap 위치와 도달 시간은 동일
export function estimateSubscriberCount({
  polledCount,
  growthRatePerHour,
  elapsedSeconds,
  safetyRatio,
}: EstimateParams): number {
  if (polledCount <= 0 || elapsedSeconds <= 0) {
    return polledCount;
  }

  const bucket = getApiBucket(polledCount);

  // 측정 불가 채널(신규 / 60일 정체)에는 bucket 기반 minimum rate 적용 →
  // 화면에서 완전히 멈춰 보이지 않게 한다. 명시적 음수 rate는 그대로 사용
  // (실제 감소 채널).
  const effectiveRate = growthRatePerHour == null || growthRatePerHour === 0
    ? bucket.unit / STAGNANT_RATE_DIVISOR
    : growthRatePerHour;

  const ratePerSecond = effectiveRate / 3600;
  const direction = effectiveRate > 0 ? 1 : -1;

  // cap 위치는 bucket 안 절대 좌표. polledCount가 bucket 어디에 있든
  // 일관되게 결정됨.
  const capPosition = direction > 0
    ? bucket.floor + safetyRatio * bucket.unit
    : bucket.floor + (1 - safetyRatio) * bucket.unit;

  const linear = polledCount + ratePerSecond * elapsedSeconds;

  const reachedCap = direction > 0
    ? linear >= capPosition
    : linear <= capPosition;

  let value: number;
  if (!reachedCap) {
    value = linear;
  } else {
    // cap 부근 sin 곡선 oscillation. timeToCap이 음수일 수 있음
    // (폴링값이 이미 cap 너머인 경우) — 그땐 그동안 cap 부근에 머물렀다고
    // 보고 phase를 elapsed + |timeToCap|로 계산.
    const timeToCap = (capPosition - polledCount) / ratePerSecond;
    const phaseSeconds = elapsedSeconds - timeToCap;
    const phase = (phaseSeconds / OSCILLATION_PERIOD_SECONDS) * 2 * Math.PI;
    const amplitude = OSCILLATION_AMPLITUDE_RATIO * bucket.unit;
    value = capPosition + Math.sin(phase) * amplitude;
  }

  return clampToBucket(Math.round(value), bucket);
}
