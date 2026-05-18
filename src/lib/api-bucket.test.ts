import { describe, it, expect } from 'vitest';
import { getApiUnit, getApiBucket, clampToBucket } from './api-bucket';

describe('getApiUnit', () => {
  it('< 10M → 10,000 단위', () => {
    expect(getApiUnit(0)).toBe(10_000);
    expect(getApiUnit(5_300_000)).toBe(10_000);
    expect(getApiUnit(9_999_999)).toBe(10_000);
  });

  it('10M ~ 100M 미만 → 100,000 단위', () => {
    expect(getApiUnit(10_000_000)).toBe(100_000);
    expect(getApiUnit(11_200_000)).toBe(100_000);
    expect(getApiUnit(99_999_999)).toBe(100_000);
  });

  it('≥ 100M → 1,000,000 단위', () => {
    expect(getApiUnit(100_000_000)).toBe(1_000_000);
    expect(getApiUnit(123_000_000)).toBe(1_000_000);
  });
});

describe('getApiBucket', () => {
  it('100만 단위 채널: 5.30M → [5_300_000, 5_310_000)', () => {
    const b = getApiBucket(5_300_000);
    expect(b.floor).toBe(5_300_000);
    expect(b.ceilExclusive).toBe(5_310_000);
    expect(b.unit).toBe(10_000);
  });

  it('100만 단위 채널 + 추정값이 단위 내: bucket은 동일', () => {
    const b = getApiBucket(5_304_321);
    expect(b.floor).toBe(5_300_000);
    expect(b.ceilExclusive).toBe(5_310_000);
  });

  it('1000만 단위 채널: 11.2M → [11_200_000, 11_300_000)', () => {
    const b = getApiBucket(11_200_000);
    expect(b.floor).toBe(11_200_000);
    expect(b.ceilExclusive).toBe(11_300_000);
    expect(b.unit).toBe(100_000);
  });

  it('1억 이상 채널: 123M → [123_000_000, 124_000_000)', () => {
    const b = getApiBucket(123_000_000);
    expect(b.floor).toBe(123_000_000);
    expect(b.ceilExclusive).toBe(124_000_000);
    expect(b.unit).toBe(1_000_000);
  });

  it('경계: 9_999_999 (10M 직전)', () => {
    const b = getApiBucket(9_999_999);
    expect(b.unit).toBe(10_000);
    expect(b.floor).toBe(9_990_000);
    expect(b.ceilExclusive).toBe(10_000_000);
  });

  it('경계: 10_000_000 (10M 첫값)', () => {
    const b = getApiBucket(10_000_000);
    expect(b.unit).toBe(100_000);
    expect(b.floor).toBe(10_000_000);
    expect(b.ceilExclusive).toBe(10_100_000);
  });
});

describe('clampToBucket', () => {
  it('범위 내 값은 그대로', () => {
    const b = getApiBucket(5_300_000);
    expect(clampToBucket(5_300_500, b)).toBe(5_300_500);
    expect(clampToBucket(5_300_000, b)).toBe(5_300_000);
    expect(clampToBucket(5_309_999, b)).toBe(5_309_999);
  });

  it('상한 초과는 ceilExclusive - 1로 clamp', () => {
    const b = getApiBucket(5_300_000);
    expect(clampToBucket(5_310_000, b)).toBe(5_309_999);
    expect(clampToBucket(9_999_999, b)).toBe(5_309_999);
  });

  it('하한 미만은 floor로 clamp', () => {
    const b = getApiBucket(5_300_000);
    expect(clampToBucket(5_299_999, b)).toBe(5_300_000);
    expect(clampToBucket(0, b)).toBe(5_300_000);
  });

  it('1000만 단위 채널 범위 검증', () => {
    const b = getApiBucket(11_200_000);
    expect(clampToBucket(11_199_999, b)).toBe(11_200_000);
    expect(clampToBucket(11_300_000, b)).toBe(11_299_999);
  });
});
