'use client';

import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '@/lib/apiUrl';
import type { Channel, SnapshotResponse } from '@/lib/snapshot';

// BUG-03: 클라 30초 폴링(/api/snapshot) 폐기 → SSE 실시간 푸시 구독.
//
// 이 훅이 /api/events EventSource를 소유한다:
//   - 'snapshot' 이벤트: 전체 SnapshotResponse. status/clientChannel/채널목록
//     재동기화 + 모든 채널 target을 권위값으로 보정(baseline correction).
//   - 'channel_update' 이벤트: { channelId, subscriberCount, direction } 단건.
//     해당 채널 target만 갱신 → lerp 모션.
//
// M6의 lerp 애니메이션(이전 서버값 → 새 서버값 부드럽게 수렴)은 그대로 유지.
// 방향은 서버 direction에서 받는다.

export interface InterpolatedChannel extends Omit<Channel, 'subscriberCount'> {
  subscriberCount: number;        // 화면 표시값 (lerp 결과)
  prevCount: number;              // 직전 서버값 (RollingCounter delta source)
  polledSubscriberCount: number;  // 서버 원본값 (= lerp target)
  motionActiveUntil: number;
  motionDirection: -1 | 0 | 1;
}

const LERP_DURATION_MS = 2_000;
const MOTION_TOTAL_DURATION_MS = 4_200;

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function dirToSign(direction: 'up' | 'down' | null, delta: number): -1 | 0 | 1 {
  if (direction === 'up') return 1;
  if (direction === 'down') return -1;
  return (Math.sign(delta) as -1 | 0 | 1);
}

interface ChannelUpdateMsg {
  channelId: string;
  subscriberCount: number;
  direction: 'up' | 'down' | null;
  changedAt: string;
}

export interface LiveSnapshot {
  snapshot: SnapshotResponse | undefined;
  channels: InterpolatedChannel[];
}

export function useLiveSnapshot(initialData: SnapshotResponse | null): LiveSnapshot {
  const displayCountsRef = useRef<Map<string, number>>(new Map());
  const targetCountsRef = useRef<Map<string, number>>(new Map());
  const prevTargetRef = useRef<Map<string, number>>(new Map());
  const lerpStartValueRef = useRef<Map<string, number>>(new Map());
  const lerpStartAtRef = useRef<Map<string, number>>(new Map());
  const motionUntilRef = useRef<Map<string, number>>(new Map());
  const motionDirRef = useRef<Map<string, -1 | 0 | 1>>(new Map());
  const latestChannelsRef = useRef<Channel[]>(initialData?.channels ?? []);
  const rafRef = useRef<number | null>(null);

  const [snapshot, setSnapshot] = useState<SnapshotResponse | undefined>(initialData ?? undefined);
  const [interpolated, setInterpolated] = useState<InterpolatedChannel[]>([]);

  // 전체 snapshot 수신: 채널 목록 + target 재동기화(권위값 보정).
  function applySnapshot(snap: SnapshotResponse, now: number): void {
    const isFirst = targetCountsRef.current.size === 0;
    const incoming = new Set<string>();
    for (const ch of snap.channels) {
      const id = ch.id;
      incoming.add(id);
      const newTarget = ch.subscriberCount;
      const oldTarget = targetCountsRef.current.get(id);
      if (isFirst || oldTarget === undefined) {
        displayCountsRef.current.set(id, newTarget);
        prevTargetRef.current.set(id, newTarget);
        lerpStartAtRef.current.set(id, 0);
      } else if (newTarget !== oldTarget) {
        const startVal = displayCountsRef.current.get(id) ?? oldTarget;
        lerpStartValueRef.current.set(id, startVal);
        lerpStartAtRef.current.set(id, now);
        prevTargetRef.current.set(id, oldTarget);
        motionDirRef.current.set(id, dirToSign(ch.lastChangeDirection, newTarget - startVal));
        motionUntilRef.current.set(id, now + MOTION_TOTAL_DURATION_MS);
      }
      targetCountsRef.current.set(id, newTarget);
    }
    for (const map of [
      displayCountsRef.current, targetCountsRef.current, prevTargetRef.current,
      lerpStartValueRef.current, lerpStartAtRef.current, motionUntilRef.current, motionDirRef.current,
    ]) {
      for (const id of [...map.keys()]) if (!incoming.has(id)) map.delete(id);
    }
    latestChannelsRef.current = snap.channels;
    setSnapshot(snap);
  }

  // 단건 channel_update: 해당 채널 target만 갱신 → lerp.
  function applyChannelUpdate(u: ChannelUpdateMsg, now: number): void {
    const id = u.channelId;
    const oldTarget = targetCountsRef.current.get(id);
    if (oldTarget === undefined) return; // 다음 snapshot에 등장할 채널 — 무시
    if (u.subscriberCount !== oldTarget) {
      const startVal = displayCountsRef.current.get(id) ?? oldTarget;
      lerpStartValueRef.current.set(id, startVal);
      lerpStartAtRef.current.set(id, now);
      prevTargetRef.current.set(id, oldTarget);
      motionDirRef.current.set(id, dirToSign(u.direction, u.subscriberCount - startVal));
      motionUntilRef.current.set(id, now + MOTION_TOTAL_DURATION_MS);
    }
    targetCountsRef.current.set(id, u.subscriberCount);
  }

  // 초기 seed (SSR initialData).
  const hydratedRef = useRef(false);
  if (!hydratedRef.current && initialData && initialData.channels.length > 0) {
    hydratedRef.current = true;
    applySnapshot(initialData, Date.now());
  }

  // EventSource 구독.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const es = new EventSource(apiUrl('/api/events'));

    const onSnapshot = (e: MessageEvent) => {
      try { applySnapshot(JSON.parse(e.data) as SnapshotResponse, Date.now()); } catch { /* ignore */ }
    };
    const onUpdate = (e: MessageEvent) => {
      try { applyChannelUpdate(JSON.parse(e.data) as ChannelUpdateMsg, Date.now()); } catch { /* ignore */ }
    };
    es.addEventListener('snapshot', onSnapshot);
    es.addEventListener('channel_update', onUpdate);

    return () => {
      es.removeEventListener('snapshot', onSnapshot);
      es.removeEventListener('channel_update', onUpdate);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // RAF lerp 루프.
  useEffect(() => {
    function tick() {
      const now = Date.now();
      const result: InterpolatedChannel[] = latestChannelsRef.current.map((ch) => {
        const id = ch.id;
        const target = targetCountsRef.current.get(id) ?? ch.subscriberCount;
        const startAt = lerpStartAtRef.current.get(id) ?? 0;

        let display: number;
        if (startAt === 0) {
          display = target;
        } else {
          const startVal = lerpStartValueRef.current.get(id) ?? target;
          const t = Math.min((now - startAt) / LERP_DURATION_MS, 1);
          display = Math.round(startVal + (target - startVal) * easeOut(t));
          if (t >= 1) {
            display = target;
            lerpStartAtRef.current.set(id, 0);
            prevTargetRef.current.set(id, target);
          }
        }
        displayCountsRef.current.set(id, display);

        const motionUntil = motionUntilRef.current.get(id) ?? 0;
        const motionActiveUntil = motionUntil > now ? motionUntil : 0;
        const motionDirection: -1 | 0 | 1 =
          motionActiveUntil > now ? (motionDirRef.current.get(id) ?? 0) : 0;
        const prevCount = prevTargetRef.current.get(id) ?? display;

        return {
          ...ch,
          subscriberCount: display,
          prevCount,
          polledSubscriberCount: ch.subscriberCount,
          motionActiveUntil,
          motionDirection,
        };
      });
      setInterpolated(result);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  return { snapshot, channels: interpolated };
}
