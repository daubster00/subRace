import { describe, it, expect } from 'vitest';
import { interpolate } from './interpolation';

const INTERVAL = 21600; // 6h in seconds
const SAFETY = 0.85;

describe('interpolate', () => {
  it('정상 구간: t < 0.85×tInterval에서 선형 증가 반환', () => {
    const sPrev = 9_900_000;
    const sCurr = 10_000_000;
    const r = (sCurr - sPrev) / INTERVAL;
    const t = INTERVAL * 0.25;
    const result = interpolate({ sPrev, sCurr, tInterval: INTERVAL, t, safetyRatio: SAFETY });
    expect(result).toBeCloseTo(sCurr + r * t, 0);
  });

  it('감속 구간: t = tInterval에서 sSafe를 절대 추월하지 않음', () => {
    const sPrev = 9_900_000;
    const sCurr = 10_000_000;
    const sSafe = sCurr + SAFETY * (sCurr - sPrev); // 10_085_000
    const result = interpolate({ sPrev, sCurr, tInterval: INTERVAL, t: INTERVAL, safetyRatio: SAFETY });
    expect(result).toBeLessThanOrEqual(sSafe);
    expect(result).toBeGreaterThanOrEqual(sCurr);
  });

  it('PRD 검증 예시: 1000만→1010만 6h, 안전 한계 1008.5만', () => {
    const sCurr = 10_000_000;
    const sPrev2 = 9_900_000; // r×tInterval = 100_000
    const sSafe = sCurr + SAFETY * 100_000; // 10_085_000
    const tSafe = INTERVAL * SAFETY; // 0.85 × 6h = 18360s
    const resultAtSafe = interpolate({ sPrev: sPrev2, sCurr, tInterval: INTERVAL, t: tSafe, safetyRatio: SAFETY });
    expect(resultAtSafe).toBeCloseTo(sSafe, 0);

    const resultPast = interpolate({ sPrev: sPrev2, sCurr, tInterval: INTERVAL, t: INTERVAL, safetyRatio: SAFETY });
    expect(resultPast).toBeLessThanOrEqual(sSafe + 1);
  });

  it('감소 방향: r < 0이면 sSafe 아래로 하락하지 않음', () => {
    const sPrev = 10_200_000;
    const sCurr = 10_000_000;
    const sSafe = sCurr + SAFETY * (sCurr - sPrev); // 9_830_000
    const result = interpolate({ sPrev, sCurr, tInterval: INTERVAL, t: INTERVAL, safetyRatio: SAFETY });
    expect(result).toBeGreaterThanOrEqual(sSafe - 1);
    expect(result).toBeLessThanOrEqual(sCurr);
  });

  it('sPrev === null: sCurr 그대로 반환 (첫 부팅)', () => {
    const result = interpolate({ sPrev: null, sCurr: 10_000_000, tInterval: INTERVAL, t: 3600, safetyRatio: SAFETY });
    expect(result).toBe(10_000_000);
  });

  it('t === 0: sCurr 그대로 반환', () => {
    const result = interpolate({ sPrev: 9_900_000, sCurr: 10_000_000, tInterval: INTERVAL, t: 0, safetyRatio: SAFETY });
    expect(result).toBe(10_000_000);
  });
});
