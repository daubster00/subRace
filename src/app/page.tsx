import { connection } from 'next/server';
import { readSnapshot } from '@/lib/snapshot';
import { env } from '@/lib/env';
import { Dashboard } from '@/app/_components/Dashboard';
import type { SnapshotResponse } from '@/lib/snapshot';
import type { ClientConfig } from '@/lib/client-config';

export default async function Home() {
  await connection();

  let initialData: SnapshotResponse | null = null;
  try {
    initialData = readSnapshot();
  } catch {
    // 빈 DB 또는 DB 장애 — Dashboard가 null initialData를 처리
  }

  const config: ClientConfig = {
    youtubePollIntervalHours: env.YOUTUBE_POLL_INTERVAL_HOURS,
    estimationSafetyRatio: env.ESTIMATION_SAFETY_RATIO,
    rankAlertAbsoluteThreshold: env.RANK_ALERT_ABSOLUTE_THRESHOLD,
    rankAlertTimeThresholdHours: env.RANK_ALERT_TIME_THRESHOLD_HOURS,
    timezone: env.TIMEZONE,
  };

  return <Dashboard initialData={initialData} displayLimit={env.DISPLAY_LIMIT} config={config} />;
}
