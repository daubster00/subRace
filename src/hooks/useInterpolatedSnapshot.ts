'use client';

import { useEffect, useRef, useState } from 'react';
import { getApiBucket, clampToBucket, type ApiBucket } from '@/lib/api-bucket';
import type { Channel, SnapshotResponse } from '@/lib/snapshot';

export interface InterpolatedChannel extends Omit<Channel, 'subscriberCount'> {
  subscriberCount: number;
  prevCount: number;
  polledSubscriberCount: number;
  motionActiveUntil: number;
  motionDirection: -1 | 0 | 1;
}

const CORRECTION_DURATION_MS = 1500;
// Matches the total RankCard border trace + corner animation time
// (left trace: 1575ms delay + 2600ms duration ≈ 4175ms)
const MOTION_TOTAL_DURATION_MS = 4_200;
const DISPLAY_COUNTS_STORAGE_KEY = 'subRace:displayCounts:v2';
const DISPLAY_COUNTS_TTL_MS = 24 * 60 * 60 * 1000;
const DISPLAY_COUNTS_SAVE_INTERVAL_MS = 2_000;
const MIN_STEP_MS = 650;
const MAX_STEP_MS = 1_400;
const MAX_ACTIVE_MOTIONS = 30;

// 채널의 growthRatePerHour로 모션 빈도를 결정. 변동 큰 채널은 자주, 정체
// 채널은 드물게 → ISSEI(1,374/h) 같은 핫 채널이 모션 큐를 잡고 늘어지는 일
// 없이 자기 페이스로 빠르게 따라잡는다. 정체 채널은 어차피 보여줄 변화가
// 없으니 대역폭을 양보.
interface MotionCadence {
  cooldownMin: number; // 모션 종료 후 다음 모션까지 차단 (ms)
  cooldownMax: number;
  idleMin: number;     // 모션 결정(skip 포함) 후 다음 결정까지 (ms)
  idleMax: number;
}

function getMotionCadence(growthRatePerHour: number | null): MotionCadence {
  const rate = Math.abs(growthRatePerHour ?? 0);
  if (rate >= 500) {
    // Hot (ISSEI tier ≈ 1,374/h). 채널당 cycle 2~5s.
    return { cooldownMin: 1_500, cooldownMax: 3_500, idleMin: 600, idleMax: 1_800 };
  }
  if (rate >= 100) {
    // Active (ADO tier ≈ 96/h~수백/h). cycle 5~12s.
    return { cooldownMin: 3_500, cooldownMax: 8_000, idleMin: 1_500, idleMax: 4_000 };
  }
  if (rate >= 20) {
    // Mid. cycle 10~23s.
    return { cooldownMin: 7_000, cooldownMax: 15_000, idleMin: 2_500, idleMax: 8_000 };
  }
  // Quiet / stagnant. cycle 20~44s, 큐 대역폭 양보.
  return { cooldownMin: 15_000, cooldownMax: 30_000, idleMin: 5_000, idleMax: 14_000 };
}
// 채널 간 새 모션 시작 사이의 최소 간격(랜덤). 같은 프레임/근접 프레임에
// 여러 채널이 동시에 모션을 시작해 어색하게 보이는 것을 막는다.
// 상한은 "전체 뷰에서 변화가 멈춰 있는 최대 시간"을 직접 결정한다 — 3초 미만으로 유지.
const MIN_NEW_MOTION_GAP_MS = 220;
const MAX_NEW_MOTION_GAP_MS = 1_100;

interface MotionState {
  nextDecisionAt: number;
  activeUntil: number;
  nextStepAt: number;
  direction: -1 | 0 | 1;
  driftTarget: number;
  repeatBlockedUntil: number;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getSignedStep(gap: number): number {
  const absGap = Math.abs(gap);
  if (absGap <= 0) return 0;

  const ceiling = clamp(Math.ceil(absGap * randomBetween(0.015, 0.08)), 1, 180);
  return Math.sign(gap) * Math.max(1, Math.min(absGap, Math.round(randomBetween(1, ceiling))));
}

function getFlatDriftAmplitude(count: number, bucket: ApiBucket): number {
  let base: number;
  if (count >= 50_000_000) base = 2_400;
  else if (count >= 10_000_000) base = 1_500;
  else if (count >= 5_000_000) base = 1_000;
  else if (count >= 1_000_000) base = 650;
  else base = 260;
  // Cap at half the API unit so a symmetric ±amplitude swing centered near the
  // middle of the bucket stays inside it. Boundary positions still rely on the
  // explicit clamp in the caller, but capping here keeps targets from being
  // dragged hard against the floor/ceil on every motion.
  const halfUnit = Math.floor(bucket.unit / 2);
  return Math.min(base, halfUnit);
}

function createMotionState(now: number, cadence: MotionCadence): MotionState {
  return {
    nextDecisionAt: now + randomBetween(0, cadence.idleMax),
    activeUntil: 0,
    nextStepAt: 0,
    direction: 0,
    driftTarget: 0,
    repeatBlockedUntil: 0,
  };
}

function startMotion(state: MotionState, now: number, direction: -1 | 1, driftTarget: number) {
  state.direction = direction;
  state.driftTarget = driftTarget;
  state.activeUntil = now + MOTION_TOTAL_DURATION_MS;
  state.nextStepAt = now + randomBetween(150, 600);
}

function endMotion(state: MotionState, now: number, cadence: MotionCadence) {
  state.direction = 0;
  state.activeUntil = 0;
  state.nextStepAt = 0;
  state.driftTarget = 0;
  state.repeatBlockedUntil = now + randomBetween(cadence.cooldownMin, cadence.cooldownMax);
  state.nextDecisionAt = state.repeatBlockedUntil + randomBetween(cadence.idleMin, cadence.idleMax);
}

function stepFlatCount({
  current,
  polled,
  bucket,
  state,
  now,
  canStartMotion,
  cadence,
}: {
  current: number;
  polled: number;
  bucket: ApiBucket;
  state: MotionState;
  now: number;
  canStartMotion: boolean;
  cadence: MotionCadence;
}): number {
  if (state.direction !== 0 && now > state.activeUntil) {
    endMotion(state, now, cadence);
  }

  if (state.direction === 0 && now >= state.nextDecisionAt) {
    if (!canStartMotion || now < state.repeatBlockedUntil) {
      state.nextDecisionAt = Math.max(state.repeatBlockedUntil, now + randomBetween(cadence.idleMin, cadence.idleMax));
      return current;
    }

    const amplitude = getFlatDriftAmplitude(polled, bucket);
    const distanceFromPolled = current - polled;
    const shouldReturn = Math.abs(distanceFromPolled) > amplitude * 0.65 || Math.random() < 0.38;
    const nextOffset = shouldReturn
      ? randomBetween(-amplitude * 0.18, amplitude * 0.18)
      : randomBetween(-amplitude, amplitude);

    const driftTarget = clampToBucket(Math.round(polled + nextOffset), bucket);
    const direction = Math.sign(driftTarget - current) as -1 | 0 | 1;
    if (direction === 0) {
      state.nextDecisionAt = now + randomBetween(cadence.idleMin, cadence.idleMax);
      return current;
    }
    startMotion(state, now, direction, driftTarget);
  }

  if (state.direction === 0 || now < state.nextStepAt || now > state.activeUntil) {
    return current;
  }

  const gap = state.driftTarget - current;
  if (gap === 0) {
    state.nextStepAt = now + randomBetween(MIN_STEP_MS, MAX_STEP_MS);
    return current;
  }
  const next = current + getSignedStep(gap);
  const stepped = gap > 0 ? Math.min(next, state.driftTarget) : Math.max(next, state.driftTarget);
  // 한 모션 구간에서 숫자는 정확히 한 번만 변화한다
  if (stepped !== current) {
    state.nextStepAt = state.activeUntil + 1;
  } else {
    state.nextStepAt = now + randomBetween(MIN_STEP_MS, MAX_STEP_MS);
  }
  return stepped;
}

function stepNaturalCount({
  channelId,
  current,
  polled,
  target,
  bucket,
  stateMap,
  now,
  canStartMotion,
  cadence,
}: {
  channelId: string;
  current: number;
  polled: number;
  target: number;
  bucket: ApiBucket;
  stateMap: Map<string, MotionState>;
  now: number;
  canStartMotion: boolean;
  cadence: MotionCadence;
}): number {
  const trend = Math.sign(target - polled) as -1 | 0 | 1;

  let state = stateMap.get(channelId);
  if (!state) {
    state = createMotionState(now, cadence);
    stateMap.set(channelId, state);
  }

  if (trend === 0 || target === current) {
    return stepFlatCount({ current, polled, bucket, state, now, canStartMotion, cadence });
  }

  if (state.direction !== 0 && now > state.activeUntil) {
    endMotion(state, now, cadence);
  }

  if (state.direction === 0 && now >= state.nextDecisionAt) {
    if (!canStartMotion || now < state.repeatBlockedUntil) {
      state.nextDecisionAt = Math.max(state.repeatBlockedUntil, now + randomBetween(cadence.idleMin, cadence.idleMax));
      return current;
    }

    const absGap = Math.abs(target - current);
    const pressure = clamp(absGap / 2_000, 0, 1);
    const hasRoomForCorrection = trend > 0 ? current > polled + 3 : current < polled - 3;
    const shouldCorrect = hasRoomForCorrection && Math.random() < 0.16;
    const shouldMove = Math.random() < 0.35 + pressure * 0.45;

    if (shouldCorrect) {
      const correctionDirection = (-trend) as -1 | 1;
      const rawCorrection = trend > 0
        ? Math.max(polled, current - Math.max(1, Math.round(randomBetween(2, 12))))
        : Math.min(polled, current + Math.max(1, Math.round(randomBetween(2, 12))));
      const correctionTarget = clampToBucket(rawCorrection, bucket);
      startMotion(state, now, correctionDirection, correctionTarget);
    } else if (shouldMove) {
      startMotion(state, now, trend as -1 | 1, clampToBucket(target, bucket));
    } else {
      state.nextDecisionAt = now + randomBetween(cadence.idleMin, cadence.idleMax);
    }
  }

  if (state.direction === 0 || now < state.nextStepAt || now > state.activeUntil) {
    return current;
  }

  const driftGap = state.driftTarget - current;
  if (driftGap === 0) {
    state.nextStepAt = now + randomBetween(MIN_STEP_MS, MAX_STEP_MS);
    return current;
  }

  const next = current + getSignedStep(driftGap);
  const stepped = driftGap > 0 ? Math.min(next, state.driftTarget) : Math.max(next, state.driftTarget);
  // 한 모션 구간에서 숫자는 정확히 한 번만 변화한다
  if (stepped !== current) {
    state.nextStepAt = state.activeUntil + 1;
  } else {
    state.nextStepAt = now + randomBetween(MIN_STEP_MS, MAX_STEP_MS);
  }
  return stepped;
}

function getChannelSnapshotTime(ch: Channel): number {
  const t = new Date(ch.snapshottedAt).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function loadPersistedDisplayCounts(): Map<string, number> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(DISPLAY_COUNTS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as { savedAt?: unknown; counts?: unknown } | null;
    if (
      !parsed ||
      typeof parsed.savedAt !== 'number' ||
      Date.now() - parsed.savedAt > DISPLAY_COUNTS_TTL_MS ||
      !parsed.counts ||
      typeof parsed.counts !== 'object'
    ) {
      return new Map();
    }
    const entries = Object.entries(parsed.counts as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0
    );
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function persistDisplayCounts(counts: Map<string, number>, now: number): void {
  if (typeof window === 'undefined') return;
  try {
    const obj: Record<string, number> = {};
    for (const [id, count] of counts) {
      obj[id] = count;
    }
    window.localStorage.setItem(
      DISPLAY_COUNTS_STORAGE_KEY,
      JSON.stringify({ savedAt: now, counts: obj })
    );
  } catch {
    // ignore quota / serialization errors
  }
}

export function useInterpolatedSnapshot(
  data: SnapshotResponse | undefined,
  // 폴링 간격은 더 이상 추정/보간 cap에 쓰이지 않는다 (마일스톤 기반으로 전환됨).
  // 시그니처는 Dashboard 호출부 호환을 위해 유지.
  _pollIntervalHours: number,
  safetyRatio: number,
): InterpolatedChannel[] {
  const currCountsRef = useRef<Map<string, number>>(new Map());
  // Per-channel arrival time. YouTube's subscriberCount is rounded to 3 sig
  // figs for large channels, so many consecutive polls return an identical
  // value. For unchanged channels we keep the old arrival time so interpolation
  // keeps drifting upward instead of resetting back to the same polled value.
  const snapshotArrivedAtRef = useRef<Map<string, number>>(new Map());
  const latestChannelsRef = useRef<Channel[]>([]);
  const rafRef = useRef<number | null>(null);

  // Smooth correction: track last displayed values so new snapshot arrival lerps from them
  const displayCountsRef = useRef<Map<string, number>>(new Map());
  const correctionStartCountsRef = useRef<Map<string, number>>(new Map());
  const correctionStartAtRef = useRef<number>(0);
  const motionStatesRef = useRef<Map<string, MotionState>>(new Map());
  const lastPersistedAtRef = useRef<number>(0);
  // 마지막으로 어떤 채널이 새 모션을 시작한 시각과, 다음 모션 시작까지 강제할 랜덤 gap.
  // tick마다 새로 뽑지 않고 모션이 시작될 때만 갱신해, 시작 간격이 일관되게 분산된다.
  const lastMotionStartedAtRef = useRef<number>(0);
  const newMotionGapRef = useRef<number>(0);

  // Hydrate drifted counts from localStorage on first render so a page reload
  // (including the settings-save reload) preserves the last interpolated values.
  // When localStorage is empty (cold tab, incognito, >24h absence), seed from
  // the server-projected estimatedSubscriberCount so the first tick starts at a
  // natural drifted value instead of snapping back to the raw polled count.
  const hydratedRef = useRef(false);
  if (!hydratedRef.current && data && data.channels.length > 0) {
    hydratedRef.current = true;
    const persisted = loadPersistedDisplayCounts();
    if (persisted.size > 0) {
      displayCountsRef.current = persisted;
    } else {
      const seeded = new Map<string, number>();
      for (const ch of data.channels) {
        if (ch.estimatedSubscriberCount > 0) {
          seeded.set(ch.id, ch.estimatedSubscriberCount);
        }
      }
      if (seeded.size > 0) {
        displayCountsRef.current = seeded;
      }
    }
  }

  const [interpolated, setInterpolated] = useState<InterpolatedChannel[]>([]);

  useEffect(() => {
    if (!data || data.channels.length === 0) return;

    const incomingCounts = new Map(
      data.channels.map((ch) => [ch.id, ch.subscriberCount])
    );

    const isFirstLoad = currCountsRef.current.size === 0;
    const changedIds = new Set<string>();
    for (const [id, count] of incomingCounts) {
      if (currCountsRef.current.get(id) !== count) changedIds.add(id);
    }

    // Only channels whose polled value actually changed get a correction lerp.
    // Unchanged channels keep drifting from their current display value — the
    // YouTube API returns the same rounded count for hours/days, so snapping
    // them back to that stale value would visibly undo legitimate drift.
    if (!isFirstLoad && changedIds.size > 0 && displayCountsRef.current.size > 0) {
      const startMap = new Map<string, number>();
      for (const id of changedIds) {
        const display = displayCountsRef.current.get(id);
        if (display !== undefined) startMap.set(id, display);
      }
      if (startMap.size > 0) {
        correctionStartCountsRef.current = startMap;
        correctionStartAtRef.current = Date.now();
      }
    }

    currCountsRef.current = incomingCounts;

    if (isFirstLoad) {
      const seeded = new Map<string, number>();
      for (const ch of data.channels) seeded.set(ch.id, getChannelSnapshotTime(ch));
      snapshotArrivedAtRef.current = seeded;
    } else if (changedIds.size > 0) {
      for (const ch of data.channels) {
        if (changedIds.has(ch.id)) {
          snapshotArrivedAtRef.current.set(ch.id, getChannelSnapshotTime(ch));
        }
      }
      for (const id of [...snapshotArrivedAtRef.current.keys()]) {
        if (!incomingCounts.has(id)) snapshotArrivedAtRef.current.delete(id);
      }
    }

    latestChannelsRef.current = data.channels;
  }, [data]);

  useEffect(() => {
    if (!data) return;

    function tick() {
      const now = Date.now();

      const correctionElapsedMs = now - correctionStartAtRef.current;
      const correctionProgress = correctionStartAtRef.current === 0
        ? 1
        : Math.min(correctionElapsedMs / CORRECTION_DURATION_MS, 1);
      const correctionFactor = 1 - (1 - correctionProgress) ** 2;

      // Count channels currently in an active motion window so we can cap concurrency
      let activeMotionCount = 0;
      for (const state of motionStatesRef.current.values()) {
        if (state.direction !== 0 && state.activeUntil > now) {
          activeMotionCount++;
        }
      }

      // 직전 모션 시작으로부터 충분한 랜덤 간격이 지났을 때만 새 모션을 허용한다.
      // 같은 tick / 가까운 tick에 여러 채널이 동시에 모션을 켜는 것을 막아 자연스럽게 분산시킨다.
      let motionGapReady = lastMotionStartedAtRef.current === 0
        || (now - lastMotionStartedAtRef.current) >= newMotionGapRef.current;

      const result: InterpolatedChannel[] = latestChannelsRef.current.map((ch) => {
        const sCurr = currCountsRef.current.get(ch.id) ?? ch.subscriberCount;
        const previousDisplay = displayCountsRef.current.get(ch.id) ?? sCurr;

        // bucket은 폴링값 기준 — drifted display가 다음 bucket으로 넘어가지 못하게 유지.
        const bucket = sCurr > 0 ? getApiBucket(sCurr) : null;

        // M5: target = polled. server의 display_state가 executor step마다 갱신되니
        // 클라이언트 forward-projection 불필요. previousDisplay → polled로 자연 모션.
        const interpolatedTarget = sCurr;

        const correctionStartForChannel = correctionStartCountsRef.current.get(ch.id);
        let displayCount: number;
        let lerpMotionDirection: -1 | 0 | 1 = 0;
        if (correctionProgress < 1 && correctionStartForChannel !== undefined) {
          displayCount = Math.round(
            correctionStartForChannel + (interpolatedTarget - correctionStartForChannel) * correctionFactor
          );
          motionStatesRef.current.delete(ch.id);
          lerpMotionDirection = Math.sign(
            interpolatedTarget - correctionStartForChannel
          ) as -1 | 0 | 1;
        } else if (bucket) {
          const stateBefore = motionStatesRef.current.get(ch.id);
          const wasActiveBefore = (stateBefore?.activeUntil ?? 0) > now && (stateBefore?.direction ?? 0) !== 0;

          displayCount = stepNaturalCount({
            channelId: ch.id,
            current: previousDisplay,
            polled: sCurr,
            target: interpolatedTarget,
            bucket,
            stateMap: motionStatesRef.current,
            now,
            canStartMotion: activeMotionCount < MAX_ACTIVE_MOTIONS && motionGapReady,
            cadence: getMotionCadence(ch.growthRatePerHour),
          });

          const stateAfter = motionStatesRef.current.get(ch.id);
          const isActiveAfter = (stateAfter?.activeUntil ?? 0) > now && (stateAfter?.direction ?? 0) !== 0;
          if (!wasActiveBefore && isActiveAfter) {
            activeMotionCount++;
            lastMotionStartedAtRef.current = now;
            newMotionGapRef.current = randomBetween(MIN_NEW_MOTION_GAP_MS, MAX_NEW_MOTION_GAP_MS);
            motionGapReady = false;
          }
        } else {
          displayCount = previousDisplay;
        }

        // Final safety net — every code path above already respects the
        // bucket, but a drifted previousDisplay carried over from a poll that
        // crossed a bucket boundary could still be out of range on first tick.
        if (bucket) {
          displayCount = clampToBucket(displayCount, bucket);
        }

        const motionState = motionStatesRef.current.get(ch.id);
        let motionActiveUntil = motionState?.direction !== 0
          ? (motionState?.activeUntil ?? 0)
          : 0;
        let motionDirection: -1 | 0 | 1 = motionActiveUntil > now
          ? (motionState?.direction ?? 0)
          : 0;

        // 스냅샷 도착 직후 correction lerp 동안에는 motionStatesRef가 비어 있어
        // motionActiveUntil/Direction이 모두 0이 된다. 그런데 표시값은 lerp로
        // 매 프레임 바뀌므로 RankCard가 "테두리는 안 그리고 숫자/증감만 움직이는"
        // 상태로 빠진다 (RankCard.tsx:56). 동일 시점에 변경된 5~6 채널이 동시에
        // 이 증상을 보이는 버그의 원인.
        //
        // lerp 시작점·방향으로 합성 모션 윈도우를 부여해 테두리 트리거를 살린다.
        // CSS border 애니메이션(약 4.2s) 풀 사이클을 보장하기 위해
        // MOTION_TOTAL_DURATION_MS 만큼 유지. 자연 모션 state machine은 건드리지
        // 않으므로 lerp 종료 후 정상 재개된다.
        if (lerpMotionDirection !== 0) {
          motionDirection = lerpMotionDirection;
          motionActiveUntil = Math.max(
            motionActiveUntil,
            correctionStartAtRef.current + MOTION_TOTAL_DURATION_MS,
          );
        }

        displayCountsRef.current.set(ch.id, displayCount);

        return {
          ...ch,
          subscriberCount: displayCount,
          prevCount: previousDisplay,
          polledSubscriberCount: sCurr,
          motionActiveUntil,
          motionDirection,
        };
      });

      setInterpolated(result);

      if (now - lastPersistedAtRef.current >= DISPLAY_COUNTS_SAVE_INTERVAL_MS) {
        lastPersistedAtRef.current = now;
        persistDisplayCounts(displayCountsRef.current, now);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [data, safetyRatio]);

  return interpolated;
}
