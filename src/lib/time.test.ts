import { describe, it, expect } from 'vitest';
import { getJstDate, getMsUntilJstMidnight } from './time';

describe('getJstDate', () => {
  it('JST 자정 직전(UTC 14:59): 그 날의 날짜', () => {
    // 2026-05-26 14:59:59 UTC = 2026-05-26 23:59:59 JST
    expect(getJstDate(new Date('2026-05-26T14:59:59.000Z'))).toBe('2026-05-26');
  });
  it('JST 자정 정각(UTC 15:00): 다음 날의 날짜', () => {
    // 2026-05-26 15:00:00 UTC = 2026-05-27 00:00:00 JST
    expect(getJstDate(new Date('2026-05-26T15:00:00.000Z'))).toBe('2026-05-27');
  });
  it('UTC 00:00은 JST 09:00 같은 날', () => {
    expect(getJstDate(new Date('2026-05-27T00:00:00.000Z'))).toBe('2026-05-27');
  });
});

describe('getMsUntilJstMidnight', () => {
  const DAY = 86_400_000;

  it('JST 자정 정각: 24h 남음 (다음 자정)', () => {
    expect(getMsUntilJstMidnight(new Date('2026-05-26T15:00:00.000Z'))).toBe(DAY);
  });

  it('JST 자정 1초 전: 1초 남음', () => {
    expect(getMsUntilJstMidnight(new Date('2026-05-26T14:59:59.000Z'))).toBe(1000);
  });

  it('JST 정오(UTC 03:00): 12h 남음', () => {
    expect(getMsUntilJstMidnight(new Date('2026-05-27T03:00:00.000Z'))).toBe(12 * 3600 * 1000);
  });
});
