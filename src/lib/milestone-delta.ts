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

import { getApiUnit } from './api-bucket';

const MS_PER_HOUR = 3_600_000;

export interface MilestoneRow {
  polled_at: string; // ISO timestamp
  subscriber_count: number;
}

// 규칙 4 — target 산출.
//   가장 최근 마일스톤(latest)과 trendSign 방향(상승/하락/정체)을 보고, 다음
//   마일스톤(= latest에서 정확히 한 반올림 단위 위/아래)의 ratio(=0.95) 지점을
//   target으로 둔다.
//
//   target = latest + ratio × (trendSign × unit)   ← 크기는 항상 한 단위 고정
//   예) 55,100,000 상승, ratio 0.95 → 55,100,000 + 0.95×10,000 = 55,109,500
//   하락 예) 626,000 하락 → 626,000 − 0.95×1,000 = 625,050
//
// trendSign — 인접 마일스톤 transition 부호의 선형 가중합.
//   직전 두 마일스톤만 비교하면 1만 단위 경계에서 한 번 튀었다 돌아온 채널이
//   "방금 떨어진 채널"로 분류돼 SubRace 표시값이 다음 하락 마일스톤까지
//   끌려내려가는 문제(2026-06-10 고객 클레임) 발생. 최근 N개(기본 12) transition의
//   부호에 선형 weight(최신=큰 값)를 곱해 합산한 정규화 값으로 방향을 판단하고,
//   |weighted| ≤ epsilon은 정체(0)로 흡수.
//
// prev 선택은 trendSign 방향에 맞춘다 (상승 판정이면 latest보다 작은 값 중
// 가장 최근, 하락이면 큰 값 중 가장 최근). 방향에 맞는 값이 없거나 trendSign=0
// 이면 prev=latest → stepDelta=0 → target=latest (평탄).
export interface MilestoneTarget {
  target: number;
  trendSign: -1 | 0 | 1;
  latest: number;
  prev: number;
}

export interface MilestoneTargetOptions {
  maxIntervals?: number;
  epsilon?: number;
}

export function computeMilestoneTarget(
  rows: MilestoneRow[],
  ratio: number,
  opts: MilestoneTargetOptions = {},
): MilestoneTarget | null {
  if (rows.length === 0) return null;
  const latest = rows[rows.length - 1]!.subscriber_count;

  const maxIntervals = Math.max(1, opts.maxIntervals ?? 12);
  const epsilon = opts.epsilon ?? 0.5;

  // 인접 transition 부호 수집 (+1/0/-1). 최신 부호가 배열 끝.
  const allSigns: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    allSigns.push(Math.sign(rows[i]!.subscriber_count - rows[i - 1]!.subscriber_count));
  }
  const signs = allSigns.slice(-maxIntervals);

  // 가중합 정규화: 최신=큰 weight. weighted ∈ [-1, +1].
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < signs.length; i++) {
    const weight = i + 1;
    weightedSum += signs[i]! * weight;
    weightTotal += weight;
  }
  const weighted = weightTotal > 0 ? weightedSum / weightTotal : 0;

  let trendSign: -1 | 0 | 1;
  if (weighted > epsilon) trendSign = 1;
  else if (weighted < -epsilon) trendSign = -1;
  else trendSign = 0;

  // prev: trendSign 방향에 맞는 가장 최근의 다른 값. 없거나 trendSign=0이면
  // prev=latest로 두어 target=latest (평탄).
  let prev = latest;
  if (trendSign !== 0) {
    for (let i = rows.length - 2; i >= 0; i--) {
      const v = rows[i]!.subscriber_count;
      if (trendSign === 1 && v < latest) { prev = v; break; }
      if (trendSign === -1 && v > latest) { prev = v; break; }
    }
  }

  // 2026-06-18 고객 정정: 다음 마일스톤은 항상 정확히 "한 반올림 단위" 위/아래.
  // 직전 기록 마일스톤까지의 실제 간격(latest − prev)을 크기로 쓰면, 마일스톤
  // 기록에 공백이 생긴 채널(예: 3,670,000 다음 기록이 곧장 3,700,000)에서 간격이
  // 여러 단위로 잡혀 목표가 한 칸 이상 부풀어 실제 API를 추월하던 버그(Nintendo).
  // 이제 prev는 방향(부호) 판단에만 쓰고, 크기는 무조건 한 단위로 고정한다.
  //   상승: target = latest + ratio × unit  (예: 55,100,000 → 55,109,500)
  //   하락: target = latest − ratio × unit
  //   정체(trendSign 0): stepDelta 0 → target = latest
  const unit = getApiUnit(latest);
  const stepDelta = trendSign * unit;
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
