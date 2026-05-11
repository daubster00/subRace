'use client';

import { useEffect, useRef, useState } from 'react';
import { interpolate } from '@/lib/interpolation';
import type { Channel, SnapshotResponse } from '@/lib/snapshot';

export interface InterpolatedChannel extends Omit<Channel, 'subscriberCount'> {
  subscriberCount: number;
  prevCount: number;
}

const CORRECTION_DURATION_MS = 1500;
const MIN_IDLE_MS = 4_000;
const MAX_IDLE_MS = 55_000;
const MIN_BURST_MS = 2_500;
const MAX_BURST_MS = 12_000;
const MIN_STEP_MS = 650;
const MAX_STEP_MS = 2_200;
const MIN_AFTER_CHANGE_COOLDOWN_MS = 8_000;
const MAX_AFTER_CHANGE_COOLDOWN_MS = 24_000;

interface MotionState {
  nextDecisionAt: number;
  activeUntil: number;
  nextStepAt: number;
  direction: -1 | 0 | 1;
  cooldownUntil: number;
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

function scheduleIdle(state: MotionState, now: number, pressure: number) {
  const pressureFactor = clamp(pressure, 0, 1);
  const idleMs = randomBetween(MIN_IDLE_MS, MAX_IDLE_MS * (1 - pressureFactor * 0.72));
  state.direction = 0;
  state.activeUntil = 0;
  state.nextStepAt = 0;
  state.nextDecisionAt = now + idleMs;
}

function scheduleBurst(state: MotionState, now: number, direction: -1 | 1) {
  state.direction = direction;
  state.activeUntil = now + randomBetween(MIN_BURST_MS, MAX_BURST_MS);
  state.nextStepAt = now + randomBetween(120, 900);
  state.nextDecisionAt = state.activeUntil + randomBetween(MIN_IDLE_MS, MAX_IDLE_MS);
}

function scheduleAfterChangeCooldown(state: MotionState, now: number) {
  const cooldownMs = randomBetween(MIN_AFTER_CHANGE_COOLDOWN_MS, MAX_AFTER_CHANGE_COOLDOWN_MS);
  state.direction = 0;
  state.activeUntil = 0;
  state.nextStepAt = 0;
  state.cooldownUntil = now + cooldownMs;
  state.nextDecisionAt = state.cooldownUntil + randomBetween(MIN_IDLE_MS, MAX_IDLE_MS);
}

function stepNaturalCount({
  channelId,
  current,
  polled,
  target,
  stateMap,
  now,
}: {
  channelId: string;
  current: number;
  polled: number;
  target: number;
  stateMap: Map<string, MotionState>;
  now: number;
}): number {
  const gapToTarget = target - current;
  const trend = Math.sign(target - polled) as -1 | 0 | 1;

  if (trend === 0 || gapToTarget === 0) {
    stateMap.delete(channelId);
    return target;
  }

  let state = stateMap.get(channelId);
  if (!state) {
    state = {
      nextDecisionAt: now + randomBetween(0, MAX_IDLE_MS),
      activeUntil: 0,
      nextStepAt: 0,
      direction: 0,
      cooldownUntil: 0,
    };
    stateMap.set(channelId, state);
  }

  if (now < state.cooldownUntil) {
    return current;
  }

  if (now >= state.nextDecisionAt) {
    const absGap = Math.abs(gapToTarget);
    const pressure = clamp(absGap / 2_000, 0, 1);
    const hasRoomForCorrection = trend > 0 ? current > polled + 3 : current < polled - 3;
    const correctionDirection = (-trend) as -1 | 1;
    const shouldCorrect = hasRoomForCorrection && Math.random() < 0.16;
    const shouldMove = Math.random() < 0.35 + pressure * 0.45;

    if (shouldCorrect) {
      scheduleBurst(state, now, correctionDirection);
    } else if (shouldMove) {
      scheduleBurst(state, now, trend);
    } else {
      scheduleIdle(state, now, pressure);
    }
  }

  if (state.direction === 0 || now < state.nextStepAt || now > state.activeUntil) {
    return current;
  }

  state.nextStepAt = now + randomBetween(MIN_STEP_MS, MAX_STEP_MS);

  if (state.direction === trend) {
    const next = current + getSignedStep(target - current);
    const stepped = trend > 0 ? Math.min(next, target) : Math.max(next, target);
    if (stepped !== current) scheduleAfterChangeCooldown(state, now);
    return stepped;
  }

  const correctionFloor = trend > 0 ? polled : target;
  const correctionCeil = trend > 0 ? target : polled;
  const correctionTarget = trend > 0
    ? Math.max(polled, current - Math.max(1, Math.round(randomBetween(1, 8))))
    : Math.min(polled, current + Math.max(1, Math.round(randomBetween(1, 8))));

  const stepped = clamp(correctionTarget, correctionFloor, correctionCeil);
  if (stepped !== current) scheduleAfterChangeCooldown(state, now);
  return stepped;
}

function getSnapshotTime(channels: Channel[]): number {
  const times = channels
    .map((ch) => new Date(ch.snapshottedAt).getTime())
    .filter((time) => Number.isFinite(time));

  return times.length > 0 ? Math.max(...times) : Date.now();
}

export function useInterpolatedSnapshot(
  data: SnapshotResponse | undefined,
  pollIntervalHours: number,
  safetyRatio: number,
): InterpolatedChannel[] {
  const prevCountsRef = useRef<Map<string, number>>(new Map());
  const currCountsRef = useRef<Map<string, number>>(new Map());
  const snapshotArrivedAtRef = useRef<number>(0);
  const latestChannelsRef = useRef<Channel[]>([]);
  const rafRef = useRef<number | null>(null);

  // Smooth correction: track last displayed values so new snapshot arrival lerps from them
  const displayCountsRef = useRef<Map<string, number>>(new Map());
  const correctionStartCountsRef = useRef<Map<string, number>>(new Map());
  const correctionStartAtRef = useRef<number>(0);
  const motionStatesRef = useRef<Map<string, MotionState>>(new Map());

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

    let countsChanged = currCountsRef.current.size === 0;
    if (!countsChanged) {
      for (const [id, count] of incomingCounts) {
        if (currCountsRef.current.get(id) !== count) {
          countsChanged = true;
          break;
        }
      }
    }

    if (countsChanged) {
      // Only start a correction lerp when replacing an existing snapshot (not first load)
      if (currCountsRef.current.size > 0 && displayCountsRef.current.size > 0) {
        correctionStartCountsRef.current = new Map(displayCountsRef.current);
        correctionStartAtRef.current = Date.now();
      }
      prevCountsRef.current = incomingPreviousCounts;
      currCountsRef.current = incomingCounts;
      snapshotArrivedAtRef.current = getSnapshotTime(data.channels);
    }

    latestChannelsRef.current = data.channels;
  }, [data, pollIntervalHours]);

  useEffect(() => {
    if (!data) return;

    const tInterval = pollIntervalHours * 3600;

    function tick() {
      const elapsedSeconds = (Date.now() - snapshotArrivedAtRef.current) / 1000;

      const correctionElapsedMs = Date.now() - correctionStartAtRef.current;
      const correctionProgress = correctionStartAtRef.current === 0
        ? 1
        : Math.min(correctionElapsedMs / CORRECTION_DURATION_MS, 1);
      // ease-out: reaches target quickly then slows down
      const correctionFactor = 1 - (1 - correctionProgress) ** 2;

      const result: InterpolatedChannel[] = latestChannelsRef.current.map((ch) => {
        // 0은 "데이터 없음"(COALESCE 기본값)이므로 null과 동일하게 처리 — 보간 없음
        const sPrevRaw = prevCountsRef.current.get(ch.id);
        const sPrev = sPrevRaw != null && sPrevRaw > 0 ? sPrevRaw : null;
        const sCurr = currCountsRef.current.get(ch.id) ?? ch.subscriberCount;
        const previousDisplay = displayCountsRef.current.get(ch.id) ?? sCurr;

        const interpolatedTarget = Math.round(
          interpolate({ sPrev, sCurr, tInterval, t: elapsedSeconds, safetyRatio })
        );

        let displayCount: number;
        if (correctionProgress >= 1) {
          displayCount = interpolatedTarget;
        } else {
          const correctionStart = correctionStartCountsRef.current.get(ch.id) ?? interpolatedTarget;
          displayCount = Math.round(
            correctionStart + (interpolatedTarget - correctionStart) * correctionFactor
          );
          motionStatesRef.current.delete(ch.id);
        }

        if (correctionProgress >= 1) {
          displayCount = stepNaturalCount({
            channelId: ch.id,
            current: previousDisplay,
            polled: sCurr,
            target: interpolatedTarget,
            stateMap: motionStatesRef.current,
            now: Date.now(),
          });
        }

        displayCountsRef.current.set(ch.id, displayCount);

        return {
          ...ch,
          subscriberCount: displayCount,
          prevCount: previousDisplay,
        };
      });

      setInterpolated(result);
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
