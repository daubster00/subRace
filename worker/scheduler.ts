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

// Likes polling cadence is tracked in-memory because it doesn't log to a
// dedicated polls table; on worker restart we just fire once on startup and
// then resume the cadence. Losing this on restart is harmless — the worst case
// is one extra poll, which costs 1 unit when CLIENT_VIDEO_ID is set.
let lastLikesPollAt: Date | null = null;
// Set by startScheduler so triggerLikesPoll can route reload-driven refreshes
// through the same single-flight as the cadence tick.
let runLikesFn: (() => Promise<void>) | null = null;

export function startScheduler(): void {
  // env values are read inside each tick so runtime-settings overrides
  // (set via the settings UI) take effect without restarting the worker.
  const yuturaIntervalMs = (): number => env.YUTURA_INTERVAL_HOURS * 60 * 60 * 1000;
  const channelsIntervalMs = (): number => env.YOUTUBE_POLL_INTERVAL_HOURS * 60 * 60 * 1000;
  const likesIntervalMs = (): number => env.YOUTUBE_LIKES_POLL_INTERVAL_HOURS * 60 * 60 * 1000;

  // isDue() only inspects the last *finished* poll, so without single-flight
  // locks a long-running poll (yutura resolve ~225s) would overlap with the
  // next 60s tick and fan out duplicate upstream requests.
  const runYutura = createSingleFlight(() => pollYutura());
  const runChannels = createSingleFlight(() => pollYoutubeChannels());
  const runLikes = createSingleFlight(async () => {
    try {
      await pollYoutubeLikes();
    } finally {
      // Update the in-memory cursor even on failure so a persistent error
      // (e.g. quota exhausted) doesn't busy-loop the API.
      lastLikesPollAt = new Date();
    }
  });
  runLikesFn = runLikes;

  if (isDue(getLastSuccessAt('yutura_pulls'), yuturaIntervalMs())) void runYutura();

  const channelsDue = isDue(getLastYoutubePacedAt(), channelsIntervalMs()) || hasChannelsWithoutSnapshots();
  console.log(`[scheduler] channels_due=${channelsDue} channels_without_snapshots=${hasChannelsWithoutSnapshots()}`);
  if (channelsDue) void runChannels();

  // No persisted last-poll for likes — fire once on startup, then cadence.
  void runLikes();

  setInterval(() => {
    if (isDue(getLastSuccessAt('yutura_pulls'), yuturaIntervalMs())) void runYutura();
  }, 60_000);

  setInterval(() => {
    if (isDue(getLastYoutubePacedAt(), channelsIntervalMs())) void runChannels();
  }, 60_000);

  setInterval(() => {
    if (isDue(lastLikesPollAt, likesIntervalMs())) void runLikes();
  }, 60_000);

  startLivePoller();
}

// Exposed so the settings reload path can force a likes refresh immediately
// after CLIENT_CHANNEL_ID / CLIENT_VIDEO_ID changes. Routes through the same
// single-flight as the cadence tick so we never have two pollYoutubeLikes
// in flight at once.
export function triggerLikesPoll(): void {
  if (runLikesFn) void runLikesFn();
}
