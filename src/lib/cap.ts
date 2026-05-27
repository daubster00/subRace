import { getNextMilestone } from './next-milestone';

// cap = 다음 마일스톤까지 남은 거리의 safetyRatio 지점.
//
//   cap = api + (next_milestone - api) * safetyRatio
//
// 예: api=75_492_000, next=75_500_000, safetyRatio=0.85
//     → cap = 75_492_000 + 8_000 * 0.85 = 75_498_800
//
// safetyRatio는 GPT 스펙(0.85)을 기본으로 호출자가 명시 — 헬퍼는 env에 직접
// 의존하지 않는다(테스트 가능성·재사용성).
//
// next_milestone에 이미 도달했거나 넘어선 경우(api ≥ next_milestone) cap은
// api로 잡힌다(여유 0). 이런 상황은 정상 흐름에선 발생하지 않지만
// (getNextMilestone이 항상 ceilExclusive > api), 안전망으로 floor 처리.
export function computeCap(apiCount: number, safetyRatio: number): number {
  const next = getNextMilestone(apiCount);
  const room = Math.max(0, next - apiCount);
  return Math.floor(apiCount + room * safetyRatio);
}
