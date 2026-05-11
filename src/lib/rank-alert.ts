// PRD §4.5 (F-10): 순위 역전 임박 판정 (AND 조건: 절대값 + 시간 임계)
// 순수 함수 — React/DB/env 의존 없음, 호출자가 임계값을 인자로 전달

export interface AlertChannel {
  id: string;
  subscriberCount: number;   // 현재 구독자 수 (보간 후 표시값 권장)
  growthRatePerHour: number; // 시간당 증가율 (호출자가 sPrev/sCurr/tInterval로 계산해서 전달)
}

export interface AlertPair {
  upperChannelId: string; // 상위 순위 (N위)
  lowerChannelId: string; // 하위 순위 (N+1위)
}

export interface DetectAlertsParams {
  rankedChannels: AlertChannel[]; // 순위 순서대로 (index 0 = 1위)
  absThreshold: number;           // 절대값 임계 (기본 10,000) — 호출자가 env에서 읽어 전달
  timeThresholdHours: number;     // 시간 임계 (기본 1h) — 호출자가 env에서 읽어 전달
}

export function detectAlerts({ rankedChannels, absThreshold, timeThresholdHours }: DetectAlertsParams): AlertPair[] {
  const alerts: AlertPair[] = [];
  for (let i = 0; i < rankedChannels.length - 1; i++) {
    const upper = rankedChannels[i]!;
    const lower = rankedChannels[i + 1]!;
    const gap = upper.subscriberCount - lower.subscriberCount;
    const deltaR = lower.growthRatePerHour - upper.growthRatePerHour;

    if (gap < absThreshold && deltaR > 0 && gap / deltaR < timeThresholdHours) {
      alerts.push({ upperChannelId: upper.id, lowerChannelId: lower.id });
    }
  }
  return alerts;
}
