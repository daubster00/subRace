import { describe, it, expect } from 'vitest';
import { interpolate, estimateSubscriberCount } from './interpolation';

const INTERVAL = 21600; // 6h in seconds (옛 interpolate 테스트 보존용)
const SAFETY = 0.85;

describe('interpolate (legacy)', () => {
  it('정상 구간: t < 0.85×tInterval에서 선형 증가 반환', () => {
    const sPrev = 9_900_000;
    const sCurr = 10_000_000;
    const r = (sCurr - sPrev) / INTERVAL;
    const t = INTERVAL * 0.25;
    const result = interpolate({ sPrev, sCurr, tInterval: INTERVAL, t, safetyRatio: SAFETY });
    expect(result).toBeCloseTo(sCurr + r * t, 0);
  });

  it('sPrev === null: sCurr 그대로 반환', () => {
    const result = interpolate({ sPrev: null, sCurr: 10_000_000, tInterval: INTERVAL, t: 3600, safetyRatio: SAFETY });
    expect(result).toBe(10_000_000);
  });

  it('t === 0: sCurr 그대로 반환', () => {
    const result = interpolate({ sPrev: 9_900_000, sCurr: 10_000_000, tInterval: INTERVAL, t: 0, safetyRatio: SAFETY });
    expect(result).toBe(10_000_000);
  });
});

describe('estimateSubscriberCount (마일스톤 기반)', () => {
  it('성장률 null인 신규 채널도 minimum rate로 미세 증가', () => {
    // 1만 unit bucket: minimum rate = 10_000 / 2880 ≈ 3.47/h
    // 1시간 경과 → +3~4 (round)
    const r = estimateSubscriberCount({
      polledCount: 5_300_000,
      growthRatePerHour: null,
      elapsedSeconds: 3600,
      safetyRatio: SAFETY,
    });
    expect(r).toBeGreaterThan(5_300_000);
    expect(r).toBeLessThan(5_300_010);
  });

  it('성장률 0인 정체 채널도 minimum rate로 미세 증가', () => {
    // 1만 unit bucket: minimum rate = 10_000 / 2880 ≈ 3.47/h
    // 24시간 경과 → +83 (round)
    const r = estimateSubscriberCount({
      polledCount: 5_300_000,
      growthRatePerHour: 0,
      elapsedSeconds: 24 * 3600,
      safetyRatio: SAFETY,
    });
    expect(r).toBeGreaterThan(5_300_000);
    expect(r).toBeLessThanOrEqual(5_300_100);
  });

  it('100만 unit 채널의 minimum rate ≈ 347/h', () => {
    // 1억대 100만 unit bucket: minimum rate = 1_000_000 / 2880 ≈ 347.2/h
    // 1시간 경과 → +347 (round)
    const r = estimateSubscriberCount({
      polledCount: 123_000_000,
      growthRatePerHour: 0,
      elapsedSeconds: 3600,
      safetyRatio: SAFETY,
    });
    expect(r).toBeGreaterThan(123_000_340);
    expect(r).toBeLessThan(123_000_360);
  });

  it('경과 0이면 폴링값 그대로 (방금 폴링됨)', () => {
    const r = estimateSubscriberCount({
      polledCount: 5_300_000,
      growthRatePerHour: 600,
      elapsedSeconds: 0,
      safetyRatio: SAFETY,
    });
    expect(r).toBe(5_300_000);
  });

  it('cap 도달 전: rate × elapsed 자연 누적 (폴링 간격 무관)', () => {
    // 1만 단위 bucket, growthRate +600/h × 1시간 → +600
    // cap = 5,308,500 (85%) — 1시간으론 도달 못함
    const r = estimateSubscriberCount({
      polledCount: 5_300_000,
      growthRatePerHour: 600,
      elapsedSeconds: 3600,
      safetyRatio: SAFETY,
    });
    expect(r).toBe(5_300_600);
  });

  it('cap 도달 시간: 폴링 간격이 5분이든 6시간이든 동일', () => {
    // 100만 unit bucket (123M 채널), rate +100_000/h
    // capPosition = 123_000_000 + 0.85 × 1_000_000 = 123_850_000
    // 도달 시간 = 850_000 / 100_000 = 8.5h
    // 4시간 경과 시점 (도달 전): linear = 123_000_000 + 400_000 = 123_400_000
    const r = estimateSubscriberCount({
      polledCount: 123_000_000,
      growthRatePerHour: 100_000,
      elapsedSeconds: 4 * 3600,
      safetyRatio: SAFETY,
    });
    expect(r).toBe(123_400_000);
  });

  it('cap 도달 후: cap ± 10% × unit 범위에서 oscillation (정지 X)', () => {
    // 1만 unit bucket, rate +1000/h → cap 도달 = 8.5h
    // 100h 경과 → 한참 cap 너머. cap=5,308,500, amplitude=1,000
    // 값은 [5,307,500, 5,309,500] 범위 안.
    const r = estimateSubscriberCount({
      polledCount: 5_300_000,
      growthRatePerHour: 1000,
      elapsedSeconds: 100 * 3600,
      safetyRatio: SAFETY,
    });
    expect(r).toBeGreaterThanOrEqual(5_307_500);
    expect(r).toBeLessThanOrEqual(5_309_500);
  });

  it('oscillation은 시간에 따라 변화 (멈춰있지 않음)', () => {
    // cap 도달 후 시점 두 개 — 사인 주기 600초의 1/4, 3/4 위치 = sin이 최대/최소
    const params = {
      polledCount: 5_300_000,
      growthRatePerHour: 1000,
      safetyRatio: SAFETY,
    };
    // cap 도달까지 = 8500/(1000/3600) = 30600초. 그 뒤 150초/450초 시점
    const a = estimateSubscriberCount({ ...params, elapsedSeconds: 30600 + 150 });
    const b = estimateSubscriberCount({ ...params, elapsedSeconds: 30600 + 450 });
    expect(a).not.toBe(b);
  });

  it('API bucket 침범 절대 금지 (1만 unit 채널)', () => {
    // 시간당 +1만 (매우 가파른 채널). 6시간 경과해도 [5_300_000, 5_310_000) 안에 머물러야.
    const r = estimateSubscriberCount({
      polledCount: 5_300_000,
      growthRatePerHour: 10_000,
      elapsedSeconds: 6 * 3600,
      safetyRatio: SAFETY,
    });
    expect(r).toBeGreaterThanOrEqual(5_300_000);
    expect(r).toBeLessThan(5_310_000);
  });

  it('API bucket 침범 절대 금지 (1억대 100만 unit 채널)', () => {
    const r = estimateSubscriberCount({
      polledCount: 123_000_000,
      growthRatePerHour: 1_000_000,
      elapsedSeconds: 30 * 24 * 3600,
      safetyRatio: SAFETY,
    });
    expect(r).toBeGreaterThanOrEqual(123_000_000);
    expect(r).toBeLessThan(124_000_000);
  });

  it('감소 채널: cap이 bucket 하단 15% 위치 (1 - safetyRatio)', () => {
    // 폴링 5_305_000 (bucket 중간), rate -500/h
    // capPosition = 5_300_000 + 0.15 × 10_000 = 5_301_500
    // 도달 시간 = (5_305_000 - 5_301_500) / 500 = 7시간
    // 14시간 경과 → cap 너머 한참. value는 [cap - 1000, cap + 1000] 안.
    const r = estimateSubscriberCount({
      polledCount: 5_305_000,
      growthRatePerHour: -500,
      elapsedSeconds: 14 * 3600,
      safetyRatio: SAFETY,
    });
    expect(r).toBeGreaterThanOrEqual(5_300_500);
    expect(r).toBeLessThanOrEqual(5_302_500);
  });

  it('폴링 간격 무관성: 같은 rate/elapsed라면 같은 결과', () => {
    // 동일 입력이면 함수가 폴링 간격을 인자로 받지도 않으니 자명. 가시적 확인.
    const a = estimateSubscriberCount({
      polledCount: 5_300_000,
      growthRatePerHour: 600,
      elapsedSeconds: 3600,
      safetyRatio: SAFETY,
    });
    const b = estimateSubscriberCount({
      polledCount: 5_300_000,
      growthRatePerHour: 600,
      elapsedSeconds: 3600,
      safetyRatio: SAFETY,
    });
    expect(a).toBe(b);
  });

  it('정수 반올림된 결과 반환', () => {
    const r = estimateSubscriberCount({
      polledCount: 5_300_000,
      growthRatePerHour: 333,
      elapsedSeconds: 1800,
      safetyRatio: SAFETY,
    });
    expect(Number.isInteger(r)).toBe(true);
    expect(r).toBe(5_300_167); // 333 × 0.5 = 166.5 → 167
  });
});
