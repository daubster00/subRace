import { describe, it, expect } from 'vitest';
import { detectAlerts } from './rank-alert';

const ABS = 1000;
const TIME_H = 1;

describe('detectAlerts', () => {
  it('두 조건 모두 만족 → 임박 판정', () => {
    const channels = [
      { id: 'A', subscriberCount: 10_050, growthRatePerHour: 100 },
      { id: 'B', subscriberCount: 10_000, growthRatePerHour: 200 },
    ];
    // gap=50 < 1000 ✓, deltaR=100 > 0 ✓, t_flip=50/100=0.5h < 1h ✓
    const result = detectAlerts({ rankedChannels: channels, absThreshold: ABS, timeThresholdHours: TIME_H });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ upperChannelId: 'A', lowerChannelId: 'B' });
  });

  it('Δr ≤ 0 → 임박 X (역전 불가능)', () => {
    const channels = [
      { id: 'A', subscriberCount: 10_050, growthRatePerHour: 200 },
      { id: 'B', subscriberCount: 10_000, growthRatePerHour: 100 },
    ];
    // gap=50 < 1000이지만 deltaR = 100-200 = -100 ≤ 0 → 역전 불가
    const result = detectAlerts({ rankedChannels: channels, absThreshold: ABS, timeThresholdHours: TIME_H });
    expect(result).toHaveLength(0);
  });

  it('절대값 초과 → 임박 X', () => {
    const channels = [
      { id: 'A', subscriberCount: 500_000, growthRatePerHour: 100 },
      { id: 'B', subscriberCount: 100_000, growthRatePerHour: 200 },
    ];
    // gap=400_000 > 1000 → 조건1 미충족
    const result = detectAlerts({ rankedChannels: channels, absThreshold: ABS, timeThresholdHours: TIME_H });
    expect(result).toHaveLength(0);
  });

  it('t_flip ≥ timeThresholdHours → 임박 X', () => {
    const channels = [
      { id: 'A', subscriberCount: 10_500, growthRatePerHour: 100 },
      { id: 'B', subscriberCount: 10_000, growthRatePerHour: 101 },
    ];
    // gap=500 < 1000 ✓, deltaR=1 > 0 ✓, t_flip=500/1=500h >> 1h ✗
    const result = detectAlerts({ rankedChannels: channels, absThreshold: ABS, timeThresholdHours: TIME_H });
    expect(result).toHaveLength(0);
  });

  it('비인접 쌍 (N위, N+2위)은 판정 대상 외', () => {
    const channels = [
      { id: 'A', subscriberCount: 10_050, growthRatePerHour: 100 },
      { id: 'B', subscriberCount: 10_040, growthRatePerHour: 50 },
      { id: 'C', subscriberCount: 10_000, growthRatePerHour: 200 },
    ];
    // A-B: gap=10, deltaR=50-100=-50 ≤ 0 → 임박 X
    // B-C: gap=40 < 1000, deltaR=200-50=150 > 0, t_flip=40/150≈0.27h < 1h → 임박!
    const result = detectAlerts({ rankedChannels: channels, absThreshold: ABS, timeThresholdHours: TIME_H });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ upperChannelId: 'B', lowerChannelId: 'C' });
  });

  it('다중 인접 임박 쌍 모두 반환', () => {
    const channels = [
      { id: 'A', subscriberCount: 10_050, growthRatePerHour: 100 },
      { id: 'B', subscriberCount: 10_000, growthRatePerHour: 300 },
      { id: 'C', subscriberCount:  9_960, growthRatePerHour: 500 },
    ];
    // A-B: gap=50 < 1000, deltaR=200, t_flip=0.25h ✓
    // B-C: gap=40 < 1000, deltaR=200, t_flip=0.2h ✓
    const result = detectAlerts({ rankedChannels: channels, absThreshold: ABS, timeThresholdHours: TIME_H });
    expect(result).toHaveLength(2);
  });

  it('임박 조건 사라지면 결과에서 제외 (순수 함수라 자동)', () => {
    const channels = [
      { id: 'A', subscriberCount: 50_000, growthRatePerHour: 100 },
      { id: 'B', subscriberCount: 10_000, growthRatePerHour: 200 },
    ];
    // gap=40_000 >> 1000 → 임박 X
    const result = detectAlerts({ rankedChannels: channels, absThreshold: ABS, timeThresholdHours: TIME_H });
    expect(result).toHaveLength(0);
  });
});
