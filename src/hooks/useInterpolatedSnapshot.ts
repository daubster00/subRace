'use client';

import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '@/lib/apiUrl';
import type { Channel, SnapshotResponse } from '@/lib/snapshot';

// 2026-06-08 단순화: RAF lerp 제거.
//
// 구버전은 서버 push가 도착하면 2초짜리 lerp를 돌려 매 RAF마다 중간 정수값
// (1234 → 1235 → 1239 → … → 1254)을 토해냈다. RollingCounter의 DigitWheel은
// key에 현재 문자(`${i}-${prevChar}-${char}-${dir}`)를 끼고 있어서, 중간값이
// 들어올 때마다 휠이 매 프레임 언마운트→재마운트되며 CSS transition을 처음부터
// 다시 시작. 사용자가 본 "차라라락 여러 번 바뀌다가 들어가는" 깜박임의 원인.
//
// 휠 자체가 prev→current를 2.1~4.2초에 걸쳐 부드럽게 굴리므로 클라 lerp는
// 중복이자 간섭이다. 서버 사전 스케줄러가 한 사이클을 잘게 쪼개 보내는 것도
// 같은 시점에 두 번 잘게 쪼개는 셈. 제거하고 서버값을 그대로 한 번에 전달한다.

export interface InterpolatedChannel extends Omit<Channel, 'subscriberCount'> {
  subscriberCount: number;        // 화면 표시값 (= 최신 서버값)
  prevCount: number;              // 직전 서버값 (RollingCounter delta source)
  polledSubscriberCount: number;  // 서버 원본값 (BottomPanels surge 계산용)
  motionActiveUntil: number;
  motionDirection: -1 | 0 | 1;
}

// RankCard 테두리 트레이스(약 4.2s) 풀 사이클 길이. 모든 phase 공통 — catch-up
// 도 같은 호흡을 유지하기 위해 catchUpIntervalMs를 효과 길이 + 버퍼로 설정
// (env.SCHEDULE_CATCHUP_INTERVAL_MS=5000, 2026-06-08 customer feedback).
const MOTION_TOTAL_DURATION_MS = 4_200;
// 새 서버값 도착 후 prevCount → 새 값으로 커밋되기까지의 지연.
// 휠 애니메이션(최대 4.2s) + 여유.
const PREV_COMMIT_DELAY_MS = 5_000;

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
  const targetCountsRef = useRef<Map<string, number>>(new Map());
  const prevTargetRef = useRef<Map<string, number>>(new Map());
  const motionUntilRef = useRef<Map<string, number>>(new Map());
  const motionDirRef = useRef<Map<string, -1 | 0 | 1>>(new Map());
  const commitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const latestChannelsRef = useRef<Channel[]>(initialData?.channels ?? []);

  const [snapshot, setSnapshot] = useState<SnapshotResponse | undefined>(initialData ?? undefined);
  const [interpolated, setInterpolated] = useState<InterpolatedChannel[]>([]);

  function buildInterpolated(): InterpolatedChannel[] {
    const now = Date.now();
    return latestChannelsRef.current.map((ch) => {
      const id = ch.id;
      const target = targetCountsRef.current.get(id) ?? ch.subscriberCount;
      const prevCount = prevTargetRef.current.get(id) ?? target;
      const motionUntil = motionUntilRef.current.get(id) ?? 0;
      const motionActiveUntil = motionUntil > now ? motionUntil : 0;
      const motionDirection: -1 | 0 | 1 =
        motionActiveUntil > now ? (motionDirRef.current.get(id) ?? 0) : 0;
      return {
        ...ch,
        subscriberCount: target,
        prevCount,
        polledSubscriberCount: ch.subscriberCount,
        motionActiveUntil,
        motionDirection,
      };
    });
  }

  function scheduleCommit(id: string): void {
    const existing = commitTimersRef.current.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      const target = targetCountsRef.current.get(id);
      if (target !== undefined) {
        prevTargetRef.current.set(id, target);
      }
      commitTimersRef.current.delete(id);
      setInterpolated(buildInterpolated());
    }, PREV_COMMIT_DELAY_MS);
    commitTimersRef.current.set(id, t);
  }

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
        prevTargetRef.current.set(id, newTarget);
      } else if (newTarget !== oldTarget) {
        prevTargetRef.current.set(id, oldTarget);
        motionDirRef.current.set(id, dirToSign(ch.lastChangeDirection, newTarget - oldTarget));
        motionUntilRef.current.set(id, now + MOTION_TOTAL_DURATION_MS);
        scheduleCommit(id);
      }
      targetCountsRef.current.set(id, newTarget);
    }
    for (const map of [
      targetCountsRef.current, prevTargetRef.current,
      motionUntilRef.current, motionDirRef.current,
    ]) {
      for (const id of [...map.keys()]) if (!incoming.has(id)) map.delete(id);
    }
    for (const [id, t] of commitTimersRef.current) {
      if (!incoming.has(id)) {
        clearTimeout(t);
        commitTimersRef.current.delete(id);
      }
    }
    latestChannelsRef.current = snap.channels;
    setSnapshot(snap);
    setInterpolated(buildInterpolated());
  }

  // 단건 channel_update: 해당 채널 target만 갱신.
  function applyChannelUpdate(u: ChannelUpdateMsg, now: number): void {
    const id = u.channelId;
    const oldTarget = targetCountsRef.current.get(id);
    if (oldTarget === undefined) return; // 다음 snapshot에 등장할 채널 — 무시
    if (u.subscriberCount === oldTarget) return;
    prevTargetRef.current.set(id, oldTarget);
    motionDirRef.current.set(id, dirToSign(u.direction, u.subscriberCount - oldTarget));
    motionUntilRef.current.set(id, now + MOTION_TOTAL_DURATION_MS);
    targetCountsRef.current.set(id, u.subscriberCount);
    scheduleCommit(id);
    setInterpolated(buildInterpolated());
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
      for (const t of commitTimersRef.current.values()) clearTimeout(t);
      commitTimersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { snapshot, channels: interpolated };
}
