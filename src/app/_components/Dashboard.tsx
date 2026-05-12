'use client';

import { useRef, useState, useEffect } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { SnapshotResponse } from '@/lib/snapshot';
import { useInterpolatedSnapshot } from '@/hooks/useInterpolatedSnapshot';
import { detectAlerts } from '@/lib/rank-alert';
import type { AlertChannel, AlertPair } from '@/lib/rank-alert';
import type { ClientConfig } from '@/lib/client-config';
import { Header } from './Header';
import { Hero } from './Hero';
import { Legend } from './Legend';
import { RankGrid } from './RankGrid';
import { BottomPanels } from './BottomPanels';

interface DashboardProps {
  initialData: SnapshotResponse | null;
  displayLimit: 50 | 100;
  config: ClientConfig;
}

async function fetchSnapshot(): Promise<SnapshotResponse> {
  const res = await fetch('/api/snapshot');
  if (!res.ok) throw new Error('snapshot_fetch_failed');
  return res.json() as Promise<SnapshotResponse>;
}

export function Dashboard({ initialData, displayLimit, config }: DashboardProps) {
  const [rankPage, setRankPage] = useState<0 | 1>(0);

  const { data } = useQuery<SnapshotResponse>({
    queryKey: ['snapshot'],
    queryFn: fetchSnapshot,
    initialData: initialData ?? undefined,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    retry: 3,
    throwOnError: false,
  });

  const snapshot = data ?? {
    channels: [],
    clientChannel: { liveViewers: null, likeCount: 0, lastLivePolledAt: null },
    status: {
      yutura:      { ok: false, lastSuccessAt: null },
      youtube:     { ok: false, lastSuccessAt: null },
      live:        { ok: false, lastSuccessAt: null },
    },
    serverTime: new Date().toISOString(),
  };

  const interpolatedChannels = useInterpolatedSnapshot(
    data,
    config.youtubePollIntervalHours,
    config.estimationSafetyRatio,
  );
  const displayChannels = interpolatedChannels.length > 0
    ? interpolatedChannels
    : snapshot.channels.map((ch) => ({
        ...ch,
        prevCount: ch.subscriberCount,
        polledSubscriberCount: ch.subscriberCount,
        motionActiveUntil: 0,
        motionDirection: 0 as const,
      }));
  // Rank follows the displayed (drifted) count, not the polled count.
  // Otherwise visible numbers can appear out-of-order between adjacent ranks
  // when independent drift exceeds the polled gap.
  const sortedDisplayChannels = [...displayChannels].sort((a, b) => {
    if (b.subscriberCount !== a.subscriberCount) {
      return b.subscriberCount - a.subscriberCount;
    }
    return a.id.localeCompare(b.id);
  });
  const pageSize = 50;
  const activePage = displayLimit === 100 ? rankPage : 0;
  const pageStart = activePage * pageSize;
  const visibleChannels = sortedDisplayChannels.slice(pageStart, pageStart + pageSize);

  useEffect(() => {
    if (displayLimit !== 100) {
      return;
    }

    const id = setInterval(() => {
      setRankPage((page) => (page === 0 ? 1 : 0));
    }, 20_000);

    return () => clearInterval(id);
  }, [displayLimit]);

  const prevPollCountsRef = useRef<Map<string, number>>(new Map());
  const currPollCountsRef = useRef<Map<string, number>>(new Map());
  const [alertPairs, setAlertPairs] = useState<AlertPair[]>([]);

  useEffect(() => {
    if (!data || data.channels.length === 0) return;

    const incoming = new Map(data.channels.map((ch) => [ch.id, ch.subscriberCount]));

    let changed = currPollCountsRef.current.size === 0;
    if (!changed) {
      for (const [id, count] of incoming) {
        if (currPollCountsRef.current.get(id) !== count) {
          changed = true;
          break;
        }
      }
    }

    if (!changed) return;

    prevPollCountsRef.current = new Map(currPollCountsRef.current);
    currPollCountsRef.current = incoming;

    const tIntervalHours = config.youtubePollIntervalHours;
    const alertChannels: AlertChannel[] = data.channels.map((ch) => {
      const sPrev = prevPollCountsRef.current.get(ch.id) ?? ch.subscriberCount;
      const growthRatePerHour =
        ch.growthRatePerHour != null
          ? ch.growthRatePerHour
          : prevPollCountsRef.current.size > 0 && tIntervalHours > 0
          ? (ch.subscriberCount - sPrev) / tIntervalHours
          : 0;
      return {
        id: ch.id,
        subscriberCount: ch.subscriberCount,
        growthRatePerHour,
      };
    });

    setAlertPairs(
      detectAlerts({
        rankedChannels: alertChannels,
        absThreshold: config.rankAlertAbsoluteThreshold,
        timeThresholdHours: config.rankAlertTimeThresholdHours,
      })
    );
  }, [data, config.youtubePollIntervalHours, config.rankAlertAbsoluteThreshold, config.rankAlertTimeThresholdHours]);

  const alertedIds = new Set(
    alertPairs.flatMap((p) => [p.upperChannelId, p.lowerChannelId])
  );

  // Auto-reload on new deploy: server pushes its buildId over SSE on connect
  // (and again on EventSource auto-reconnect after the old container dies).
  // First buildId is stored as the baseline; any mismatch triggers a reload so
  // long-lived display tabs pick up new code without manual refresh.
  useEffect(() => {
    const es = new EventSource('/api/events');
    let baselineBuildId: string | null = null;

    const onHello = (event: MessageEvent) => {
      try {
        const { buildId } = JSON.parse(event.data) as { buildId?: unknown };
        if (typeof buildId !== 'string' || buildId.length === 0) return;
        if (baselineBuildId === null) {
          baselineBuildId = buildId;
        } else if (baselineBuildId !== buildId) {
          window.location.reload();
        }
      } catch {
        // ignore malformed payloads
      }
    };

    es.addEventListener('hello', onHello);
    return () => {
      es.removeEventListener('hello', onHello);
      es.close();
    };
  }, []);

  return (
    <div
      className="w-full h-screen max-h-[1080px] flex flex-col pb-[14px] overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, rgba(0,178,255,0.02), rgba(0,0,0,0))',
      }}
    >
      <Header timezone={config.timezone} />
      <main className="flex-1 min-h-0 flex flex-col px-[var(--page-padding)] pt-3">
        <Hero
          clientChannel={snapshot.clientChannel}
          displayLimit={displayLimit}
        />
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
