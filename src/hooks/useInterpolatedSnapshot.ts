'use client';

import { useEffect, useRef, useState } from 'react';
import { interpolate } from '@/lib/interpolation';
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
const DISPLAY_COUNTS_STORAGE_KEY = 'subRace:displayCounts:v1';
const DISPLAY_COUNTS_TTL_MS = 24 * 60 * 60 * 1000;
const DISPLAY_COUNTS_SAVE_INTERVAL_MS = 2_000;
const MIN_STEP_MS = 650;
const MAX_STEP_MS = 1_400;
const MIN_IDLE_MS = 2_500;
const MAX_IDLE_MS = 14_000;
const FLAT_DRIFT_MIN_DECISION_MS = 3_500;
const FLAT_DRIFT_MAX_DECISION_MS = 12_000;
const MOTION_REPEAT_COOLDOWN_MIN_MS = 7_000;
const MOTION_REPEAT_COOLDOWN_MAX_MS = 20_000;
const MAX_ACTIVE_MOTIONS = 6;
// 채널 간 새 모션 시작 사이의 최소 간격(랜덤). 같은 프레임/근접 프레임에
// 여러 채널이 동시에 모션을 시작해 어색하게 보이는 것을 막는다.
// 상한은 "전체 뷰에서 변화가 멈춰 있는 최대 시간"을 직접 결정한다 — 3초 미만으로 유지.
const MIN_NEW_MOTION_GAP_MS = 220;
const MAX_NEW_MOTION_GAP_MS = 2_400;

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

function getFlatDriftAmplitude(count: number): number {
  if (count >= 50_000_000) return 2_400;
  if (count >= 10_000_000) return 1_500;
  if (count >= 5_000_000) return 1_000;
  if (count >= 1_000_000) return 650;
  return 260;
}

function createMotionState(now: number): MotionState {
  return {
    nextDecisionAt: now + randomBetween(0, MAX_IDLE_MS),
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

function endMotion(state: MotionState, now: number) {
  state.direction = 0;
  state.activeUntil = 0;
  state.nextStepAt = 0;
  state.driftTarget = 0;
  state.repeatBlockedUntil = now + randomBetween(MOTION_REPEAT_COOLDOWN_MIN_MS, MOTION_REPEAT_COOLDOWN_MAX_MS);
  state.nextDecisionAt = state.repeatBlockedUntil + randomBetween(FLAT_DRIFT_MIN_DECISION_MS, FLAT_DRIFT_MAX_DECISION_MS);
}

function stepFlatCount({
  current,
  polled,
  state,
  now,
  canStartMotion,
}: {
  current: number;
  polled: number;
  state: MotionState;
  now: number;
  canStartMotion: boolean;
}): number {
  if (state.direction !== 0 && now > state.activeUntil) {
    endMotion(state, now);
  }

  if (state.direction === 0 && now >= state.nextDecisionAt) {
    if (!canStartMotion || now < state.repeatBlockedUntil) {
      state.nextDecisionAt = Math.max(state.repeatBlockedUntil, now + randomBetween(2_000, 7_000));
      return current;
    }

    const amplitude = getFlatDriftAmplitude(polled);
    const distanceFromPolled = current - polled;
    const shouldReturn = Math.abs(distanceFromPolled) > amplitude * 0.65 || Math.random() < 0.38;
    const nextOffset = shouldReturn
      ? randomBetween(-amplitude * 0.18, amplitude * 0.18)
      : randomBetween(-amplitude, amplitude);

    const driftTarget = Math.round(polled + nextOffset);
    const direction = Math.sign(driftTarget - current) as -1 | 0 | 1;
    if (direction === 0) {
      state.nextDecisionAt = now + randomBetween(MIN_IDLE_MS, MAX_IDLE_MS);
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
  stateMap,
  now,
  canStartMotion,
}: {
  channelId: string;
  current: number;
  polled: number;
  target: number;
  stateMap: Map<string, MotionState>;
  now: number;
  canStartMotion: boolean;
}): number {
  const trend = Math.sign(target - polled) as -1 | 0 | 1;

  let state = stateMap.get(channelId);
  if (!state) {
    state = createMotionState(now);
    stateMap.set(channelId, state);
  }

  if (trend === 0 || target === current) {
    return stepFlatCount({ current, polled, state, now, canStartMotion });
  }

  if (state.direction !== 0 && now > state.activeUntil) {
    endMotion(state, now);
  }

  if (state.direction === 0 && now >= state.nextDecisionAt) {
    if (!canStartMotion || now < state.repeatBlockedUntil) {
      state.nextDecisionAt = Math.max(state.repeatBlockedUntil, now + randomBetween(MIN_IDLE_MS, MAX_IDLE_MS));
      return current;
    }

    const absGap = Math.abs(target - current);
    const pressure = clamp(absGap / 2_000, 0, 1);
    const hasRoomForCorrection = trend > 0 ? current > polled + 3 : current < polled - 3;
    const shouldCorrect = hasRoomForCorrection && Math.random() < 0.16;
    const shouldMove = Math.random() < 0.35 + pressure * 0.45;

    if (shouldCorrect) {
      const correctionDirection = (-trend) as -1 | 1;
      const correctionTarget = trend > 0
        ? Math.max(polled, current - Math.max(1, Math.round(randomBetween(2, 12))))
        : Math.min(polled, current + Math.max(1, Math.round(randomBetween(2, 12))));
      startMotion(state, now, correctionDirection, correctionTarget);
    } else if (shouldMove) {
      startMotion(state, now, trend as -1 | 1, target);
    } else {
      state.nextDecisionAt = now + randomBetween(MIN_IDLE_MS, MAX_IDLE_MS);
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
  pollIntervalHours: number,
  safetyRatio: number,
): InterpolatedChannel[] {
  const prevCountsRef = useRef<Map<string, number>>(new Map());
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
  const hydratedRef = useRef(false);
  if (!hydratedRef.current) {
    hydratedRef.current = true;
    const persisted = loadPersistedDisplayCounts();
    if (persisted.size > 0) {
      displayCountsRef.current = persisted;
    }
  }

  const [interpolated, setInterpolated] = useState<InterpolatedChannel[]>([]);

  useEffect(() => {
    if (!data || data.channels.length === 0) return;

    const incomingCounts = new Map(
      data.channels.map((ch) => [ch.id, ch.subscriberCount])
    );
    const incomingPreviousCounts = new Map(
      data.channels.map((ch) => {
        const rate = ch.growthRatePerHour;
        const trendPrevious = rate != null
          ? Math.max(1, Math.round(ch.subscriberCount - rate * pollIntervalHours))
          : null;
        const fallbackPrevious = ch.previousSubscriberCount != null && ch.previousSubscriberCount > 0
          ? ch.previousSubscriberCount
          : null;
        return [ch.id, trendPrevious ?? fallbackPrevious] as const;
      }).filter((entry): entry is readonly [string, number] => entry[1] != null)
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

    prevCountsRef.current = incomingPreviousCounts;
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
  }, [data, pollIntervalHours]);

  useEffect(() => {
    if (!data) return;

    const tInterval = pollIntervalHours * 3600;

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
        // 0은 "데이터 없음"(COALESCE 기본값)이므로 null과 동일하게 처리 — 보간 없음
        const sPrevRaw = prevCountsRef.current.get(ch.id);
        const sPrev = sPrevRaw != null && sPrevRaw > 0 ? sPrevRaw : null;
        const sCurr = currCountsRef.current.get(ch.id) ?? ch.subscriberCount;
        const previousDisplay = displayCountsRef.current.get(ch.id) ?? sCurr;

        const arrivedAt = snapshotArrivedAtRef.current.get(ch.id) ?? now;
        const elapsedSeconds = (now - arrivedAt) / 1000;

        const interpolatedTarget = Math.round(
          interpolate({ sPrev, sCurr, tInterval, t: elapsedSeconds, safetyRatio })
        );

        const correctionStartForChannel = correctionStartCountsRef.current.get(ch.id);
        let displayCount: number;
        if (correctionProgress < 1 && correctionStartForChannel !== undefined) {
          displayCount = Math.round(
            correctionStartForChannel + (interpolatedTarget - correctionStartForChannel) * correctionFactor
          );
          motionStatesRef.current.delete(ch.id);
        } else {
          const stateBefore = motionStatesRef.current.get(ch.id);
          const wasActiveBefore = (stateBefore?.activeUntil ?? 0) > now && (stateBefore?.direction ?? 0) !== 0;

          displayCount = stepNaturalCount({
            channelId: ch.id,
            current: previousDisplay,
            polled: sCurr,
            target: interpolatedTarget,
            stateMap: motionStatesRef.current,
            now,
            canStartMotion: activeMotionCount < MAX_ACTIVE_MOTIONS && motionGapReady,
          });

          const stateAfter = motionStatesRef.current.get(ch.id);
          const isActiveAfter = (stateAfter?.activeUntil ?? 0) > now && (stateAfter?.direction ?? 0) !== 0;
          if (!wasActiveBefore && isActiveAfter) {
            activeMotionCount++;
            lastMotionStartedAtRef.current = now;
            newMotionGapRef.current = randomBetween(MIN_NEW_MOTION_GAP_MS, MAX_NEW_MOTION_GAP_MS);
            motionGapReady = false;
          }
        }

        const motionState = motionStatesRef.current.get(ch.id);
        const motionActiveUntil = motionState?.direction !== 0
          ? (motionState?.activeUntil ?? 0)
          : 0;
        const motionDirection: -1 | 0 | 1 = motionActiveUntil > now
          ? (motionState?.direction ?? 0)
          : 0;

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
  }, [data, pollIntervalHours, safetyRatio]);

  return interpolated;
}
