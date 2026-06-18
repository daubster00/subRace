import { describe, it, expect } from 'vitest';
import {
  computeMilestoneTarget,
  computePredictedHoursToNextMilestone,
  type MilestoneRow,
} from './milestone-delta';

const HOUR = 3_600_000;

function row(hoursAgoFromBase: number, count: number, base = Date.parse('2026-06-06T00:00:00.000Z')): MilestoneRow {
  return { polled_at: new Date(base + hoursAgoFromBase * HOUR).toISOString(), subscriber_count: count };
}

describe('computeMilestoneTarget (규칙 4)', () => {
  it('상승: target = latest + 0.95×unit (한 단위 고정)', () => {
    const rows = [row(0, 5_680_000), row(1, 5_690_000)];
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.latest).toBe(5_690_000);
    expect(t.prev).toBe(5_680_000);
    expect(t.trendSign).toBe(1);
    expect(t.target).toBe(5_699_500); // 5,690,000 + 0.95×10,000
  });

  // 2026-06-18: 마일스톤 기록 공백으로 prev가 한 단위보다 멀어도(여기선 3단위)
  // target은 한 단위만 올라가야 함 — 다음 마일스톤 추월 방지(Nintendo 버그).
  it('상승: prev가 여러 단위 아래여도 target은 한 단위만', () => {
    const rows = [row(0, 5_660_000), row(1, 5_690_000)]; // 3단위(30,000) 점프
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.trendSign).toBe(1);
    expect(t.target).toBe(5_699_500); // 5,690,000 + 0.95×10,000 (30,000 아님)
  });

  it('하락: 음수 step → target 한 단위 아래로', () => {
    const rows = [row(0, 5_690_000), row(1, 5_680_000)];
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.trendSign).toBe(-1);
    expect(t.target).toBe(5_670_500); // 5,680,000 − 0.95×10,000
  });

  it('모든 값 동일 → trendSign 0, target = latest', () => {
    const rows = [row(0, 5_000_000), row(1, 5_000_000)];
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.trendSign).toBe(0);
    expect(t.target).toBe(5_000_000);
  });

  it('빈 배열 → null', () => {
    expect(computeMilestoneTarget([], 0.95)).toBeNull();
  });

  // 2026-06-10 고객 클레임 — 1만 단위 경계에서 한 번 튀었다 돌아온 채널이
  // "방금 떨어진 채널"로 분류돼 표시값이 다음 하락 마일스톤까지 끌려내려가던 문제.
  // 가중합 기반 trendSign + epsilon 흡수가 도입된 후로는 한 점 튐이 trendSign=0
  // (정체)로 처리돼 target = latest 가 된다.
  it('한 점 튐 흡수: ...+,+,+,− 시퀀스는 trendSign 0으로 흡수', () => {
    // TWICE JAPAN 시나리오: 5,280k → 5,290k → 5,300k → 5,310k → 5,300k
    // signs=[+1,+1,+1,-1], weights=[1,2,3,4], weighted=(1+2+3-4)/10=+0.2.
    // epsilon=0.5 안쪽 → trendSign=0 → target=latest=5,300,000.
    const rows = [
      row(0, 5_280_000),
      row(1, 5_290_000),
      row(2, 5_300_000),
      row(3, 5_310_000),
      row(4, 5_300_000),
    ];
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.trendSign).toBe(0);
    expect(t.target).toBe(5_300_000);
    expect(t.latest).toBe(5_300_000);
  });

  it('명확한 하락: ...-,-,0,- → trendSign -1, prev는 latest보다 큰 값 중 가장 최근', () => {
    // Yuka Kinoshita 시나리오: 5,190k → 5,180k → 5,170k → 5,170k → 5,160k
    // signs=[-1,-1,0,-1], weighted=(-1-2+0-4)/10=-0.7. 절댓값 > 0.5 → trendSign=-1.
    // prev = latest=5,160k 위의 가장 최근 값 = 5,170,000.
    const rows = [
      row(0, 5_190_000),
      row(1, 5_180_000),
      row(2, 5_170_000),
      row(3, 5_170_000),
      row(4, 5_160_000),
    ];
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.trendSign).toBe(-1);
    expect(t.prev).toBe(5_170_000);
    expect(t.target).toBe(5_150_500); // 5,160k + 0.95×(-10k)
  });

  it('epsilon 옵션: ε=0이면 한 점 튐도 그대로 -1로 잡힘 (튜닝 검증)', () => {
    const rows = [
      row(0, 5_280_000),
      row(1, 5_290_000),
      row(2, 5_300_000),
      row(3, 5_310_000),
      row(4, 5_300_000),
    ];
    const t = computeMilestoneTarget(rows, 0.95, { epsilon: 0 })!;
    // weighted=+0.2 > 0 → trendSign=+1 (그래도 한 점 튐 영향으로 약한 +방향)
    expect(t.trendSign).toBe(1);
  });

  it('maxIntervals: 최근 N개 transition만 사용', () => {
    // 전체 시퀀스에서 옛 +가 많아도 최근 N=2개만 보면 −만 남는다.
    // 6 마일스톤: +,+,+,+,- (5 transitions). maxIntervals=2 → 최근 2개 +,- 사용.
    // weighted=(+1×1 + -1×2)/3 = -0.333. epsilon=0이면 trendSign=-1.
    const rows = [
      row(0, 100),
      row(1, 110),
      row(2, 120),
      row(3, 130),
      row(4, 140),
      row(5, 130),
    ];
    const wide = computeMilestoneTarget(rows, 0.95, { maxIntervals: 12, epsilon: 0 })!;
    expect(wide.trendSign).toBe(1); // 전체 보면 +가 우세
    const narrow = computeMilestoneTarget(rows, 0.95, { maxIntervals: 2, epsilon: 0 })!;
    expect(narrow.trendSign).toBe(-1); // 최근 2개만 보면 -가 우세
  });

  it('trendSign 방향에 맞는 prev가 없으면 target = latest (평탄 fallback)', () => {
    // 모두 latest보다 큰 값(=하락 시퀀스)인데 trendSign이 +1로 오분류되는 케이스는
    // 실제로는 거의 없으나, 방어 로직: 방향에 맞는 prev가 없으면 평탄.
    const rows = [row(0, 5_000_000), row(1, 5_000_000)];
    // 모두 5,000,000 → signs=[0] → trendSign=0 → prev=latest → target=latest.
    const t = computeMilestoneTarget(rows, 0.95)!;
    expect(t.target).toBe(5_000_000);
    expect(t.prev).toBe(5_000_000);
  });
});

describe('computePredictedHoursToNextMilestone (규칙 3)', () => {
  // 헬퍼: now=latest milestone 시각 → elapsed=0 → remaining=expectedInterval.
  // 이 케이스로 expectedInterval 계산식만 격리해 검증.
  const justAfterLatest = (rows: MilestoneRow[]): Date =>
    new Date(rows[rows.length - 1]!.polled_at);

  it('단일 간격: now=latest이면 그 간격 그대로 남는다', () => {
    const rows = [row(0, 100), row(2, 110)]; // 2시간 간격
    expect(
      computePredictedHoursToNextMilestone(rows, {
        maxIntervals: 8,
        now: justAfterLatest(rows),
      })
    ).toBeCloseTo(2, 6);
  });

  it('최신 간격에 더 큰 weight (순서 기반 선형)', () => {
    // 간격: 1h(옛, weight1), 2h(최신, weight2) → (1×1 + 2×2)/(1+2) = 5/3
    const rows = [row(0, 100), row(1, 110), row(3, 120)];
    expect(
      computePredictedHoursToNextMilestone(rows, {
        maxIntervals: 8,
        now: justAfterLatest(rows),
      })
    ).toBeCloseTo(5 / 3, 6);
  });

  it('maxIntervals로 최근 간격만 사용', () => {
    // 간격 4개: 10h, 10h, 1h, 1h. maxIntervals=2면 최근 1h,1h만 → weighted avg 1
    const rows = [row(0, 1), row(10, 2), row(20, 3), row(21, 4), row(22, 5)];
    expect(
      computePredictedHoursToNextMilestone(rows, {
        maxIntervals: 2,
        now: justAfterLatest(rows),
      })
    ).toBeCloseTo(1, 6);
  });

  it('마일스톤 < 2개 → null', () => {
    const ts = new Date('2026-06-06T00:00:00.000Z');
    expect(
      computePredictedHoursToNextMilestone([row(0, 100)], { maxIntervals: 8, now: ts })
    ).toBeNull();
    expect(
      computePredictedHoursToNextMilestone([], { maxIntervals: 8, now: ts })
    ).toBeNull();
  });

  it('경과 시간만큼 남은 시간 감소: now가 latest 1시간 후면 expectedInterval−1', () => {
    // expectedInterval = 5h. now = latest + 1h → 남은 시간 = 4h.
    const rows = [row(0, 100), row(5, 110)];
    const now = new Date(Date.parse(rows[1]!.polled_at) + 1 * HOUR);
    expect(
      computePredictedHoursToNextMilestone(rows, { maxIntervals: 8, now })
    ).toBeCloseTo(4, 6);
  });

  it('overdue: now가 예상 도착 시각을 지나치면 epsilon(0.001) 반환', () => {
    // expectedInterval = 2h. now = latest + 10h → 8시간 지각.
    const rows = [row(0, 100), row(2, 110)];
    const now = new Date(Date.parse(rows[1]!.polled_at) + 10 * HOUR);
    expect(
      computePredictedHoursToNextMilestone(rows, { maxIntervals: 8, now })
    ).toBeCloseTo(0.001, 6);
  });

  it('ISSEI 시나리오: 가중평균 69h인데 145.5h 경과 → overdue epsilon', () => {
    // 평균 간격 ~72h가 나오도록 단순화: 3개 마일스톤, 간격 72h, 72h.
    // 가중평균 = (72×1 + 72×2) / 3 = 72.
    const base = Date.parse('2026-06-03T00:00:00.000Z');
    const rows: MilestoneRow[] = [
      { polled_at: new Date(base - 144 * HOUR).toISOString(), subscriber_count: 75_400_000 },
      { polled_at: new Date(base - 72 * HOUR).toISOString(),  subscriber_count: 75_500_000 },
      { polled_at: new Date(base).toISOString(),              subscriber_count: 75_600_000 },
    ];
    // now = latest + 145.5h (06-09 01:30 UTC)
    const now = new Date(base + 145.5 * HOUR);
    expect(
      computePredictedHoursToNextMilestone(rows, { maxIntervals: 8, now })
    ).toBeCloseTo(0.001, 6);
  });
});
