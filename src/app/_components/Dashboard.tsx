'use client';

import { useRef, useState, useEffect } from 'react';
import type { SnapshotResponse } from '@/lib/snapshot';
import { useLiveSnapshot } from '@/hooks/useInterpolatedSnapshot';
import { detectAlerts } from '@/lib/rank-alert';
import type { AlertChannel, AlertPair } from '@/lib/rank-alert';
import type { ClientConfig } from '@/lib/client-config';
import { Header } from './Header';
import { Legend } from './Legend';
import { RankGrid } from './RankGrid';
import { BottomPanels } from './BottomPanels';

interface DashboardProps {
  initialData: SnapshotResponse | null;
  displayLimit: 50 | 100;
  config: ClientConfig;
}

export function Dashboard({ initialData, displayLimit, config }: DashboardProps) {
  const [rankPage, setRankPage] = useState<0 | 1>(0);

  // BUG-03: 폴링(useQuery) 폐기 → SSE 스트림 구독. 훅이 /api/events EventSource를
  // 소유하고 snapshot(전체) + channel_update(단건)로 표시값을 구동한다.
  const { snapshot: liveSnapshot, channels: interpolatedChannels } = useLiveSnapshot(initialData);

  const snapshot = liveSnapshot ?? {
    channels: [],
    clientChannel: { liveViewers: null, likeCount: 0, lastLivePolledAt: null },
    status: {
      yutura:  { ok: false, lastSuccessAt: null },
      youtube: { ok: false, lastSuccessAt: null },
      live:    { ok: false, lastSuccessAt: null },
    },
    serverTime: new Date().toISOString(),
  };

  const displayChannels = interpolatedChannels.length > 0
    ? interpolatedChannels
    : snapshot.channels.map((ch) => ({
        ...ch,
        subscriberCount: ch.estimatedSubscriberCount,
        prevCount: ch.estimatedSubscriberCount,
        polledSubscriberCount: ch.subscriberCount,
        motionActiveUntil: 0,
        motionDirection: 0 as const,
      }));

  // Rank는 표시(lerp)값 기준 — 인접 순위가 시각적으로 뒤바뀌어 보이지 않게.
  const sortedDisplayChannels = [...displayChannels].sort((a, b) => {
    if (b.subscriberCount !== a.subscriberCount) return b.subscriberCount - a.subscriberCount;
    return a.id.localeCompare(b.id);
  });
  const pageSize = 50;
  const activePage = displayLimit === 100 ? rankPage : 0;
  const pageStart = activePage * pageSize;
  const visibleChannels = sortedDisplayChannels.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    if (displayLimit !== 100) return;
    const id = setInterval(() => {
      setRankPage((page) => (page === 0 ? 1 : 0));
    }, 20_000);
    return () => clearInterval(id);
  }, [displayLimit]);

  // 순위 변동 임박 알림 — 전체 snapshot 도착 시(권위값) 재계산.
  const prevPollCountsRef = useRef<Map<string, number>>(new Map());
  const currPollCountsRef = useRef<Map<string, number>>(new Map());
  const [alertPairs, setAlertPairs] = useState<AlertPair[]>([]);

  useEffect(() => {
    if (!liveSnapshot || liveSnapshot.channels.length === 0) return;

    const incoming = new Map(liveSnapshot.channels.map((ch) => [ch.id, ch.subscriberCount]));
    let changed = currPollCountsRef.current.size === 0;
    if (!changed) {
      for (const [id, count] of incoming) {
        if (currPollCountsRef.current.get(id) !== count) { changed = true; break; }
      }
    }
    if (!changed) return;

    prevPollCountsRef.current = new Map(currPollCountsRef.current);
    currPollCountsRef.current = incoming;

    const tIntervalHours = config.youtubePollIntervalHours;
    const alertChannels: AlertChannel[] = liveSnapshot.channels.map((ch) => {
      const sPrev = prevPollCountsRef.current.get(ch.id) ?? ch.subscriberCount;
      const growthRatePerHour =
        ch.growthRatePerHour != null
          ? ch.growthRatePerHour
          : prevPollCountsRef.current.size > 0 && tIntervalHours > 0
          ? (ch.subscriberCount - sPrev) / tIntervalHours
          : 0;
      return { id: ch.id, subscriberCount: ch.subscriberCount, growthRatePerHour };
    });

    setAlertPairs(
      detectAlerts({
        rankedChannels: alertChannels,
        absThreshold: config.rankAlertAbsoluteThreshold,
        timeThresholdHours: config.rankAlertTimeThresholdHours,
      })
    );
  }, [liveSnapshot, config.youtubePollIntervalHours, config.rankAlertAbsoluteThreshold, config.rankAlertTimeThresholdHours]);

  const alertedIds = new Set(alertPairs.flatMap((p) => [p.upperChannelId, p.lowerChannelId]));

  // Auto-reload on new deploy: SSE snapshot이 실어 보내는 buildId를 비교.
  // 컨테이너 교체 → 기존 SSE 끊김 → 새 web에 재연결 → 새 buildId snapshot 도착 → reload.
  const baselineBuildIdRef = useRef<string | null>(null);
  useEffect(() => {
    const buildId = liveSnapshot?.buildId;
    if (typeof buildId !== 'string' || buildId.length === 0) return;
    if (baselineBuildIdRef.current === null) {
      baselineBuildIdRef.current = buildId;
    } else if (baselineBuildIdRef.current !== buildId) {
      window.location.reload();
    }
  }, [liveSnapshot?.buildId]);

  return (
    <div
      className="w-full h-screen max-h-[1080px] flex flex-col pb-[14px] overflow-hidden"
      style={{ background: 'linear-gradient(180deg, rgba(0,178,255,0.02), rgba(0,0,0,0))' }}
    >
      <Header
        timezone={config.timezone}
        clientChannel={snapshot.clientChannel}
        displayLimit={displayLimit}
      />
      <main className="flex-1 min-h-0 flex flex-col px-[var(--page-padding)] pt-[6px]">
        <Legend />
        <RankGrid
          channels={visibleChannels}
          startRank={pageStart + 1}
          alertedIds={alertedIds}
        />
        <BottomPanels
          rankPage={activePage}
          displayLimit={displayLimit}
          channels={displayChannels}
        />
      </main>
    </div>
  );
}
