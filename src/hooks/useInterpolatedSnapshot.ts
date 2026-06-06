'use client';

import { useEffect, useRef, useState } from 'react';
import type { Channel, SnapshotResponse } from '@/lib/snapshot';

// M6 컷오버 (2026-06-06, customer-feedback-2 §클라이언트 표시값 단순화).
//
// 구 버전은 서버 display_subscriber_count 위에 Math.random() 드리프트 +
// 브라우저별 localStorage를 얹어, 폴링 사이 표시 숫자가 브라우저마다 달랐다.
// 이제 서버 사전 스케줄러가 표시값의 단일 출처다 — 클라이언트는 그 값을
// 렌더링만 하고, "이전 서버값 → 새 서버값" 사이를 부드럽게 보간(lerp)할 뿐이다.
//
// 제거: stepNaturalCount / stepFlatCount / amplitude oscillation / Math.random
//       드리프트 / localStorage 영속화 전체.
// 유지: 서버값 직접 표시 + RAF lerp 수렴(폴링 주기 내) + 상승/하락 방향 표시.
//       방향은 서버 last_change_direction에서 받는다 (지뢰③ 해소).

export interface InterpolatedChannel extends Omit<Channel, 'subscriberCount'> {
  subscriberCount: number;        // 화면 표시값 (서버값으로 수렴하는 lerp 결과)
  prevCount: number;              // 직전 서버값 (RollingCounter delta source)
  polledSubscriberCount: number;  // 서버 원본값 (= lerp target). BottomPanels surge 계산용
  motionActiveUntil: number;
  motionDirection: -1 | 0 | 1;
}

// 새 서버값으로 수렴하는 lerp 길이. 기존 correction lerp(1.5s) 패턴을 참고하되,
// 폴링 주기(30s) 안에서 자연스럽게 수렴하도록 약간 길게. 수렴 후 다음 폴링까지 hold.
const LERP_DURATION_MS = 2_000;
// RankCard 테두리 트레이스(약 4.2s) 풀 사이클 길이. 카운트 변경 시 이 창 동안
// motionDirection을 노출해 상승/하락 테두리·화살표를 살린다.
const MOTION_TOTAL_DURATION_MS = 4_200;

// easeOutCubic — 빠르게 출발해 부드럽게 안착.
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function dirFromServer(
  lastChangeDirection: Channel['lastChangeDirection'],
  delta: number,
): -1 | 0 | 1 {
  if (lastChangeDirection === 'up') return 1;
  if (lastChangeDirection === 'down') return -1;
  return (Math.sign(delta) as -1 | 0 | 1);
}

export function useInterpolatedSnapshot(
  data: SnapshotResponse | undefined,
  // 폴링 간격 / safetyRatio는 더 이상 보간에 쓰이지 않는다 (마일스톤 기반 서버
  // 스케줄로 전환). Dashboard 호출부 호환을 위해 시그니처만 유지.
  _pollIntervalHours: number,
  _safetyRatio: number,
): InterpolatedChannel[] {
  // 현재 화면 표시값 (lerp 결과). localStorage 영속화 없음 — 서버가 단일 출처라
  // 새로고침/새 탭은 첫 서버 응답값에서 시작하면 모든 브라우저가 동일하다.
  const displayCountsRef = useRef<Map<string, number>>(new Map());
  const targetCountsRef = useRef<Map<string, number>>(new Map());   // 최신 서버값
  const prevTargetRef = useRef<Map<string, number>>(new Map());     // 직전 서버값
  const lerpStartValueRef = useRef<Map<string, number>>(new Map()); // lerp 시작 표시값
  const lerpStartAtRef = useRef<Map<string, number>>(new Map());    // lerp 시작 시각 (0=비활성)
  const motionUntilRef = useRef<Map<string, number>>(new Map());
  const motionDirRef = useRef<Map<string, -1 | 0 | 1>>(new Map());
  const latestChannelsRef = useRef<Channel[]>([]);
  const rafRef = useRef<number | null>(null);

  const [interpolated, setInterpolated] = useState<InterpolatedChannel[]>([]);

  // 서버 응답 도착 시: 값이 바뀐 채널만 lerp 시작. 안 바뀐 채널은 그대로 hold.
  useEffect(() => {
    if (!data || data.channels.length === 0) return;

    const now = Date.now();
    const isFirstLoad = targetCountsRef.current.size === 0;
    const incomingIds = new Set<string>();

    for (const ch of data.channels) {
      const id = ch.id;
      const newTarget = ch.subscriberCount;
      incomingIds.add(id);

      const oldTarget = targetCountsRef.current.get(id);

      if (isFirstLoad || oldTarget === undefined) {
        // 첫 페인트 / 세션 중 신규 채널 → 서버값에서 즉시 시작 (lerp 없음, 점프 없음).
        displayCountsRef.current.set(id, newTarget);
        prevTargetRef.current.set(id, newTarget);
        lerpStartAtRef.current.set(id, 0);
      } else if (newTarget !== oldTarget) {
        // 서버값 변경 → 현재 표시값에서 새 서버값으로 lerp.
        const startVal = displayCountsRef.current.get(id) ?? oldTarget;
        lerpStartValueRef.current.set(id, startVal);
        lerpStartAtRef.current.set(id, now);
        prevTargetRef.current.set(id, oldTarget);
        const dir = dirFromServer(ch.lastChangeDirection, newTarget - startVal);
        motionDirRef.current.set(id, dir);
        motionUntilRef.current.set(id, now + MOTION_TOTAL_DURATION_MS);
      }
      targetCountsRef.current.set(id, newTarget);
    }

    // 사라진 채널 정리.
    for (const map of [
      displayCountsRef.current,
      targetCountsRef.current,
      prevTargetRef.current,
      lerpStartValueRef.current,
      lerpStartAtRef.current,
      motionUntilRef.current,
      motionDirRef.current,
    ]) {
      for (const id of [...map.keys()]) {
        if (!incomingIds.has(id)) map.delete(id);
      }
    }

    latestChannelsRef.current = data.channels;
  }, [data]);

  useEffect(() => {
    if (!data) return;

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
            // 수렴 완료 — hold. idle 상태에선 prevCount == subscriberCount이 되어
            // RankCard가 잔여 delta 표시를 만들지 않는다.
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
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [data]);

  return interpolated;
}
