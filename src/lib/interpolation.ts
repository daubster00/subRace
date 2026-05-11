// PRD §4.4 (F-9): 85% 안전 비율 추정 보간 알고리즘
// sSafe는 다음 폴링까지 도달 가능한 안전한 최대/최소값 (추월 금지)

export interface InterpolateParams {
  sPrev: number | null; // 직전 폴링 구독자 수 (첫 부팅 시 null)
  sCurr: number;        // 최신 폴링 구독자 수
  tInterval: number;    // 폴링 간격 (초)
  t: number;            // 최신 폴링 이후 경과 시간 (초)
  safetyRatio: number;  // 안전 비율 (기본 0.85) — 호출자가 env에서 읽어 전달
}

export function interpolate({ sPrev, sCurr, tInterval, t, safetyRatio }: InterpolateParams): number {
  if (sPrev === null || t === 0) return sCurr;

  const r = (sCurr - sPrev) / tInterval;
  if (r === 0) return sCurr;

  const sPredicted = sCurr + r * tInterval;
  const sSafe = sCurr + safetyRatio * (sPredicted - sCurr);
  const linear = sCurr + r * t;

  return r > 0 ? Math.min(linear, sSafe) : Math.max(linear, sSafe);
}
