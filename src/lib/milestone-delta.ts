// 마일스톤 히스토리(subscriber_snapshots) → 사전 스케줄러 입력 계산.
//
// 이 모듈은 순수 계산만 한다. DB 쿼리는 호출 측(display-planner)이 한 채널의
// (polled_at, subscriber_count) 시계열을 시간순으로 정렬해 전달한다.
//
// 2026-06-06 재작성: 기존 half-life 가중 최소제곱 회귀를 폐기하고, 신규
// 사전 스케줄 아키텍처의 규칙 3·4를 구현한다 (customer-feedback-2).
//   - 규칙 4: target = 새 마일스톤 + ratio × (새 − 직전 마일스톤)
//   - 규칙 3: 다음 마일스톤까지 예상 도달 시간 = 최근 인접 간격의
//            순서 기반 선형 가중 평균 (최신 간격에 높은 weight)

const MS_PER_HOUR = 3_600_000;

export interface MilestoneRow {
  polled_at: string; // ISO timestamp
  subscriber_count: number;
}

// 규칙 4 — target 산출.
//   가장 최근 마일스톤(latest)과 그와 값이 다른 직전 마일스톤(prev)의 부호로
//   추세 방향을 정하고, 다음 예측 마일스톤의 ratio(=0.95) 지점을 target으로 둔다.
//
//   target = latest + ratio × (latest − prev)
//   예) 5,680k → 5,690k, ratio 0.95 → 5,690,000 + 0.95×10,000 = 5,699,500
//   하락 예) 626k → 625k → 625,000 + 0.95×(−1,000) = 624,050
//
// latest와 값이 다른 prev를 뒤에서부터 찾는다. (009 이후 같은 값 재진입 마일스톤이
// 연속으로 들어올 수 있어 단순히 rows[n-2]를 쓰면 trend가 0으로 뭉개진다.)
// 값이 모두 같으면(진동 없는 단조 정체) trendSign 0, target = latest.
export interface MilestoneTarget {
  target: number;
  trendSign: -1 | 0 | 1;
  latest: number;
  prev: number;
}

export function computeMilestoneTarget(
  rows: MilestoneRow[],
  ratio: number,
): MilestoneTarget | null {
  if (rows.length === 0) return null;
  const latest = rows[rows.length - 1]!.subscriber_count;

  let prev = latest;
  for (let i = rows.length - 2; i >= 0; i--) {
    if (rows[i]!.subscriber_count !== latest) {
      prev = rows[i]!.subscriber_count;
      break;
    }
  }

  const stepDelta = latest - prev;
  const trendSign = (Math.sign(stepDelta) as -1 | 0 | 1);
  const target = latest + Math.round(ratio * stepDelta);
  return { target, trendSign, latest, prev };
}

// 규칙 3 — 지금 시점부터 "다음 마일스톤 예상 도착 시각"까지 남은 시간(시간 단위).
//
//   1) 최근 maxIntervals개의 인접 마일스톤 간격(시간)에 순서별 선형 weight를 준
//      가중 평균으로 평균 간격(expectedInterval)을 얻는다.
//      weight: 가장 최근 간격 = k, 그 다음 = k−1, ..., 가장 옛것 = 1.
//   2) 예상 도착 시각 = 마지막 마일스톤 시각 + expectedInterval.
//   3) 남은 시간 = 예상 도착 시각 − now.
//
//   이미 예상 도착 시각을 지나친(overdue) 채널은 양수 epsilon으로 클램프.
//   호출 측(planTargetCycle)이 raw = full × cycleHours / remaining 을 계산하고
//   |raw| >= |full|이면 full로 다시 클램프하므로, 결과적으로 한 사이클에 gap을
//   다 닫는 동작이 된다.
//
//   날짜 무관 평균 자체는 그대로(가속/감속이 weight에 녹음). 부호 신호는 규칙 4가
//   처리하므로 여기선 간격 크기만 본다.
//
// 간격이 1개 미만(마일스톤 < 2개)이면 null — 호출 측에서 fixed 채널로 빠진다.
export function computePredictedHoursToNextMilestone(
  rows: MilestoneRow[],
  opts: { maxIntervals: number; now: Date },
): number | null {
  if (rows.length < 2) return null;

  // 인접 간격(시간). 최신이 배열 끝.
  const intervals: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const dtHours =
      (new Date(rows[i]!.polled_at).getTime() - new Date(rows[i - 1]!.polled_at).getTime()) /
      MS_PER_HOUR;
    intervals.push(dtHours);
  }

  // 최근 maxIntervals개만.
  const recent = intervals.slice(-Math.max(1, opts.maxIntervals));

  // 순서별 선형 weight: 가장 최근(배열 끝) = k, ..., 가장 옛것 = 1.
  const k = recent.length;
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < k; i++) {
    const weight = i + 1; // recent[k-1]이 최신 → weight k
    weightedSum += recent[i]! * weight;
    weightTotal += weight;
  }
  if (weightTotal === 0) return null;

  const expectedIntervalHours = weightedSum / weightTotal;
  if (!(expectedIntervalHours > 0)) return null;

  const latestAt = new Date(rows[rows.length - 1]!.polled_at).getTime();
  const elapsedHours = (opts.now.getTime() - latestAt) / MS_PER_HOUR;
  const remainingHours = expectedIntervalHours - elapsedHours;

  // overdue: 예상 도착 시각을 지나친 채널은 epsilon(0.001h)으로 클램프 →
  // planTargetCycle의 full 클램프가 작동해 사이클 안에 gap을 다 닫는다.
  return Math.max(0.001, remainingHours);
}
