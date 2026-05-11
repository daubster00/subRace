import db from '@/lib/db';
import { env } from '@/lib/env';
import { createSingleFlight } from '@/lib/single-flight';
import { pollYutura } from './yutura';
import { pollYoutubeChannels } from './youtube-channels';
import { startLivePoller } from './youtube-live';
import { pollYoutubeLikes } from './youtube-likes';

function getLastSuccessAt(table: 'yutura_pulls' | 'youtube_polls'): Date | null {
  const col = table === 'yutura_pulls' ? 'pulled_at' : 'polled_at';
  const row = db
    .prepare(`SELECT MAX(${col}) AS t FROM ${table} WHERE status = 'success'`)
    .get() as { t: string | null };
  return row.t ? new Date(row.t) : null;
}

function getLastYoutubePacedAt(): Date | null {
  const row = db
    .prepare(`
      SELECT MAX(polled_at) AS t
      FROM youtube_polls
      WHERE status IN ('success', 'quota_exceeded')
    `)
    .get() as { t: string | null };
  return row.t ? new Date(row.t) : null;
}

function isDue(lastAt: Date | null, intervalMs: number): boolean {
  if (!lastAt) return true;
  return Date.now() - lastAt.getTime() >= intervalMs;
}

function hasChannelsWithoutSnapshots(): boolean {
  const { n: activeChannels } = db.prepare(
    'SELECT COUNT(*) as n FROM channels WHERE is_active = 1'
  ).get() as { n: number };
  if (activeChannels === 0) return false;
  const { n: snapshots } = db.prepare(
    'SELECT COUNT(*) as n FROM subscriber_snapshots'
  ).get() as { n: number };
  return snapshots === 0;
}

export function startScheduler(): void {
  // env values are read inside each tick so runtime-settings overrides
  // (set via the settings UI) take effect without restarting the worker.
  const yuturaIntervalMs = (): number => env.YUTURA_INTERVAL_HOURS * 60 * 60 * 1000;
  const ytIntervalMs = (): number => env.YOUTUBE_POLL_INTERVAL_HOURS * 60 * 60 * 1000;

  // isDue() only inspects the last *finished* poll, so without single-flight
  // locks a long-running poll (yutura resolve ~225s) would overlap with the
  // next 60s tick and fan out duplicate upstream requests.
  const runYutura = createSingleFlight(() => pollYutura());
  const runYoutube = createSingleFlight(async () => {
    await pollYoutubeChannels();
    await pollYoutubeLikes();
  });

  if (isDue(getLastSuccessAt('yutura_pulls'), yuturaIntervalMs())) void runYutura();

  const ytDue = isDue(getLastYoutubePacedAt(), ytIntervalMs()) || hasChannelsWithoutSnapshots();
  console.log(`[scheduler] yt_due=${ytDue} channels_without_snapshots=${hasChannelsWithoutSnapshots()}`);
  if (ytDue) void runYoutube();

  setInterval(() => {
    if (isDue(getLastSuccessAt('yutura_pulls'), yuturaIntervalMs())) void runYutura();
  }, 60_000);

  setInterval(() => {
    if (isDue(getLastYoutubePacedAt(), ytIntervalMs())) void runYoutube();
  }, 60_000);

  startLivePoller();
}
