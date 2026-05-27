import { describe, it, expect } from 'vitest';
import { decideDirection, pickStepMagnitude, applyStep } from './display-execute';

// rng 호출 순서대로 다른 값을 돌려준다. decideDirection은 rng를 두 번 호출
// (bias 확률 픽 → 코인 토스)하므로 시퀀스 제어가 필수.
function rngSeq(...values: number[]) {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

describe('decideDirection', () => {
  const BIAS = { upMin: 0.75, upMax: 0.90, downMin: 0.60, downMax: 0.85 };

  it('todayDelta > 0, 코인 토스 < 우세 확률 → up', () => {
    // rng 시퀀스: [0.0, 0.0] → p = 0.75 + 0*0.15 = 0.75 → 0.0 < 0.75 → 'up'
    expect(decideDirection({
      todayDelta: 100, ...BIAS,
      rng: rngSeq(0.0, 0.0),
    })).toBe('up');
  });

  it('todayDelta > 0, 코인 토스 ≥ 우세 확률 → down (역방향 흔들림)', () => {
    // rng: [0.0, 0.99] → p = 0.75 → 0.99 < 0.75 ? false → 'down'
    expect(decideDirection({
      todayDelta: 100, ...BIAS,
      rng: rngSeq(0.0, 0.99),
    })).toBe('down');
  });

  it('todayDelta < 0, 코인 토스 < 우세 확률 → down', () => {
    // rng: [0.5, 0.0] → p = 0.60 + 0.5*0.25 = 0.725 → 0.0 < 0.725 → 'down'
    expect(decideDirection({
      todayDelta: -100, ...BIAS,
      rng: rngSeq(0.5, 0.0),
    })).toBe('down');
  });

  it('todayDelta < 0, 코인 토스 ≥ 우세 확률 → up', () => {
    expect(decideDirection({
      todayDelta: -100, ...BIAS,
      rng: rngSeq(0.5, 0.99),
    })).toBe('up');
  });

  it('todayDelta = 0 → up bias 처리', () => {
    // positive 분기로 가서 upMin=0.75. rng [0,0] → 'up'.
    expect(decideDirection({
      todayDelta: 0, ...BIAS,
      rng: rngSeq(0.0, 0.0),
    })).toBe('up');
  });
});

describe('pickStepMagnitude', () => {
  it('<100k: rng=0 → 1', () => {
    expect(pickStepMagnitude(50_000, () => 0)).toBe(1);
  });
  it('<100k: rng→1 직전 → 3', () => {
    // 1 + 0.9999*(3-1+1) = 1 + 2.9997 = 3.9997 → floor 3
    expect(pickStepMagnitude(50_000, () => 0.9999)).toBe(3);
  });
  it('100k~1M: rng=0.5 → 6', () => {
    // 2 + 0.5*(10-2+1) = 2 + 4.5 = 6.5 → floor 6
    expect(pickStepMagnitude(500_000, () => 0.5)).toBe(6);
  });
  it('≥10M: rng=0 → 10, rng→1 → 80', () => {
    expect(pickStepMagnitude(75_400_000, () => 0)).toBe(10);
    // 10 + 0.9999*(80-10+1) = 10 + 70.99 = 80.99 → floor 80
    expect(pickStepMagnitude(75_400_000, () => 0.9999)).toBe(80);
  });
});

describe('applyStep', () => {
  it('up: cap 여유 충분 → display + magnitude', () => {
    expect(applyStep({
      display: 75_400_000, direction: 'up', magnitude: 250,
      api: 75_400_000, cap: 75_485_000,
    })).toEqual({ display: 75_400_250, delta: 250 });
  });

  it('up: cap 초과 → cap으로 클램프', () => {
    expect(applyStep({
      display: 75_484_900, direction: 'up', magnitude: 500,
      api: 75_400_000, cap: 75_485_000,
    })).toEqual({ display: 75_485_000, delta: 100 });
  });

  it('up: 이미 cap에 닿음 → 변화 0', () => {
    expect(applyStep({
      display: 75_485_000, direction: 'up', magnitude: 500,
      api: 75_400_000, cap: 75_485_000,
    })).toEqual({ display: 75_485_000, delta: 0 });
  });

  it('down: api 여유 충분 → display - magnitude', () => {
    // display > api인 상황 (음수 추세). api까지 내려갈 여지.
    expect(applyStep({
      display: 1_000_000, direction: 'down', magnitude: 300,
      api: 950_000, cap: 958_500,
    })).toEqual({ display: 999_700, delta: -300 });
  });

  it('down: api 하한 적중 → api로 클램프', () => {
    expect(applyStep({
      display: 950_100, direction: 'down', magnitude: 500,
      api: 950_000, cap: 958_500,
    })).toEqual({ display: 950_000, delta: -100 });
  });

  it('down: 이미 api에 닿음 → 변화 0', () => {
    expect(applyStep({
      display: 950_000, direction: 'down', magnitude: 500,
      api: 950_000, cap: 958_500,
    })).toEqual({ display: 950_000, delta: 0 });
  });
});
