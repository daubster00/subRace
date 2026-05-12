import { z } from 'zod';
import db from '@/lib/db';
import { env } from '@/lib/env';

const SearchResponseSchema = z.object({
  items: z.array(z.object({
    id: z.object({ videoId: z.string() }),
  })).default([]),
});

const LiveDetailsSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    liveStreamingDetails: z.object({
      concurrentViewers: z.string().optional(),
    }).optional(),
  })).default([]),
});

let currentLiveVideoId: string | null = null;
let liveViewerIntervalId: ReturnType<typeof setInterval> | null = null;
let currentChannelId: string | null = null;

function stopLiveViewerPoller(): void {
  currentLiveVideoId = null;
  if (liveViewerIntervalId) {
    clearInterval(liveViewerIntervalId);
    liveViewerIntervalId = null;
  }
}

// Latest known like count *for the given channel* — used as a sticky carry-over
// when detectLive writes a "no live" heartbeat row, so the SummaryCard keeps
// showing the most recent likes between YouTube poll cycles.
function getLastLikeCount(channelId: string): number | null {
  const row = db.prepare(
    'SELECT like_count FROM client_channel_snapshots WHERE channel_id = ? AND like_count IS NOT NULL ORDER BY polled_at DESC LIMIT 1'
  ).get(channelId) as { like_count: number } | undefined;
  return row?.like_count ?? null;
}

async function pollLiveViewers(): Promise<void> {
  if (!currentLiveVideoId || !currentChannelId) return;
  // Capture the channel id at request start so a settings swap mid-flight
  // doesn't attribute the in-flight response to the new channel.
  const channelId = currentChannelId;
  const liveVideoId = currentLiveVideoId;
  const now = new Date().toISOString();
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${liveVideoId}&key=${env.YOUTUBE_API_KEY}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`http_error status=${response.status}`);

    const raw = await response.json() as unknown;
    const parsed = LiveDetailsSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`zod_validation_failed: ${parsed.error.message}`);

    const item = parsed.data.items[0];
    const viewers = item?.liveStreamingDetails?.concurrentViewers
      ? parseInt(item.liveStreamingDetails.concurrentViewers, 10)
      : null;

    const likeCount = getLastLikeCount(channelId);
    db.prepare(`
      INSERT OR REPLACE INTO client_channel_snapshots (polled_at, live_viewers, like_count, live_video_id, channel_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(now, viewers, likeCount, liveVideoId, channelId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] live_viewer_poll_failed reason=${message}`);
  }
}

function startViewerLoop(videoId: string): void {
  currentLiveVideoId = videoId;
  if (liveViewerIntervalId) clearInterval(liveViewerIntervalId);
  void pollLiveViewers();
  liveViewerIntervalId = setInterval(
    () => void pollLiveViewers(),
    env.LIVE_VIEWER_POLL_INTERVAL_SECONDS * 1000,
  );
}

async function detectLive(): Promise<void> {
  try {
    const channelId = env.CLIENT_CHANNEL_ID;
    const manualVideoId = env.CLIENT_VIDEO_ID;

    if (currentChannelId !== channelId) {
      currentChannelId = channelId;
      stopLiveViewerPoller();
      console.log(`[worker] live_channel_changed channel_id=${channelId}`);
    }

    // Manual override: the operator pinned a specific video. We skip search.list
    // (100 units) entirely and feed the viewer loop directly. pollLiveViewers
    // still calls videos.list (1 unit) — if the video isn't actually live,
    // concurrentViewers comes back undefined and the SummaryCard shows "—",
    // which is the same UX as no-live-detected in auto mode.
    if (manualVideoId) {
      if (manualVideoId !== currentLiveVideoId) {
        console.log(`[worker] live_video_manual_set video_id=${manualVideoId}`);
        startViewerLoop(manualVideoId);
      }
      return;
    }

    const url = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&eventType=live&type=video&key=${env.YOUTUBE_API_KEY}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`http_error status=${response.status}`);

    const raw = await response.json() as unknown;
    const parsed = SearchResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`zod_validation_failed: ${parsed.error.message}`);

    const liveVideoId = parsed.data.items[0]?.id?.videoId ?? null;

    if (liveVideoId && liveVideoId !== currentLiveVideoId) {
      startViewerLoop(liveVideoId);
    } else if (!liveVideoId) {
      stopLiveViewerPoller();
      const now = new Date().toISOString();
      const likeCount = getLastLikeCount(channelId);
      db.prepare(`
        INSERT OR REPLACE INTO client_channel_snapshots (polled_at, live_viewers, like_count, live_video_id, channel_id)
        VALUES (?, NULL, ?, NULL, ?)
      `).run(now, likeCount, channelId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] live_detect_failed reason=${message}`);
  }
}

export function triggerLiveDetect(): void {
  void detectLive();
}

export function startLivePoller(): void {
  void detectLive();
  // Hourly re-detect catches live streams that come up/go down without any
  // settings change. Channel-id changes are pushed to us by the web on save
  // (see worker/internal-server.ts), so no per-second polling is needed.
  setInterval(() => void detectLive(), 60 * 60 * 1000);
}
