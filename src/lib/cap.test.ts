import { describe, it, expect } from 'vitest';
import { computeCap } from './cap';

describe('computeCap', () => {
  it('api=950_000 → next=960_000 (1만 bucket), ratio=0.85 → cap=958_500', () => {
    // spec.md L249~254 예시는 next_milestone=1_000_000 가정이지만,
    // M1 결정(audit §5.1)에 따라 next_milestone은 api-bucket의 ceilExclusive.
    // 950_000은 <10M → 1만 단위 → bucket [950_000, 960_000) → next=960_000.
    // cap = 950_000 + 10_000 * 0.85 = 958_500.
    expect(computeCap(950_000, 0.85)).toBe(958_500);
  });

  it('75.4M ISSEI 예시: next=75_500_000, ratio=0.85', () => {
    // cap = 75_400_000 + 100_000 * 0.85 = 75_485_000
    expect(computeCap(75_400_000, 0.85)).toBe(75_485_000);
  });

  it('이미 마일스톤에 도달한 경우(api 정확히 bucket 경계): 다음 bucket 기준', () => {
    // api=75_500_000 → next=75_600_000 → cap = 75_500_000 + 100_000 * 0.85 = 75_585_000
    expect(computeCap(75_500_000, 0.85)).toBe(75_585_000);
  });

  it('100M 단위: api=123_400_000 → next=124_000_000', () => {
    // cap = 123_400_000 + 600_000 * 0.85 = 123_910_000
    expect(computeCap(123_400_000, 0.85)).toBe(123_910_000);
  });

  it('safetyRatio=1.0 → cap = next_milestone', () => {
    expect(computeCap(75_400_000, 1.0)).toBe(75_500_000);
  });

  it('safetyRatio=0 → cap = api (도달 후 흔들림만)', () => {
    expect(computeCap(75_400_000, 0)).toBe(75_400_000);
  });
});
