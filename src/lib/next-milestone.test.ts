import { describe, it, expect } from 'vitest';
import { getNextMilestone } from './next-milestone';

describe('getNextMilestone', () => {
  it('<10M (1만 단위): 5_300_000 → 5_310_000', () => {
    expect(getNextMilestone(5_300_000)).toBe(5_310_000);
    expect(getNextMilestone(5_304_321)).toBe(5_310_000);
    expect(getNextMilestone(9_999_999)).toBe(10_000_000);
  });

  it('<100M (10만 단위): 75_400_000 → 75_500_000', () => {
    expect(getNextMilestone(75_400_000)).toBe(75_500_000);
    expect(getNextMilestone(75_492_345)).toBe(75_500_000);
    expect(getNextMilestone(11_200_000)).toBe(11_300_000);
    expect(getNextMilestone(99_999_999)).toBe(100_000_000);
  });

  it('≥100M (100만 단위): 123_400_000 → 124_000_000', () => {
    expect(getNextMilestone(123_400_000)).toBe(124_000_000);
    expect(getNextMilestone(123_000_000)).toBe(124_000_000);
  });

  it('bucket 경계값: 75_500_000 → 75_600_000 (현재 값은 이미 도달한 마일스톤)', () => {
    expect(getNextMilestone(75_500_000)).toBe(75_600_000);
    expect(getNextMilestone(10_000_000)).toBe(10_100_000);
    expect(getNextMilestone(100_000_000)).toBe(101_000_000);
  });
});
