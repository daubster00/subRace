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

function getLastLikeCount(): number | null {
  const row = db.prepare(
    'SELECT like_count FROM client_channel_snapshots WHERE like_count IS NOT NULL ORDER BY polled_at DESC LIMIT 1'
  ).get() as { like_count: number } | undefined;
  return row?.like_count ?? null;
}

async function pollLiveViewers(): Promise<void> {
  if (!currentLiveVideoId) return;
  const now = new Date().toISOString();
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${currentLiveVideoId}&key=${env.YOUTUBE_API_KEY}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`http_error status=${response.status}`);

    const raw = await response.json() as unknown;
    const parsed = LiveDetailsSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`zod_validation_failed: ${parsed.error.message}`);

    const item = parsed.data.items[0];
    const viewers = item?.liveStreamingDetails?.concurrentViewers
      ? parseInt(item.liveStreamingDetails.concurrentViewers, 10)
      : null;

    const likeCount = getLastLikeCount();
    db.prepare(`
      INSERT OR REPLACE INTO client_channel_snapshots (polled_at, live_viewers, like_count, live_video_id)
      VALUES (?, ?, ?, ?)
    `).run(now, viewers, likeCount, currentLiveVideoId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] live_viewer_poll_failed reason=${message}`);
  }
}

async function detectLive(): Promise<void> {
  try {
    const channelId = env.CLIENT_CHANNEL_ID;
    if (currentChannelId !== channelId) {
      currentChannelId = channelId;
      stopLiveViewerPoller();
      console.log(`[worker] live_channel_changed channel_id=${channelId}`);
    }

    const url = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&eventType=live&type=video&key=${env.YOUTUBE_API_KEY}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`http_error status=${response.status}`);

    const raw = await response.json() as unknown;
    const parsed = SearchResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`zod_validation_failed: ${parsed.error.message}`);

    const liveVideoId = parsed.data.items[0]?.id?.videoId ?? null;

    if (liveVideoId && liveVideoId !== currentLiveVideoId) {
      currentLiveVideoId = liveVideoId;
      if (liveViewerIntervalId) clearInterval(liveViewerIntervalId);
      void pollLiveViewers();
      liveViewerIntervalId = setInterval(() => void pollLiveViewers(), env.LIVE_VIEWER_POLL_INTERVAL_SECONDS * 1000);
    } else if (!liveVideoId) {
      stopLiveViewerPoller();
      const now = new Date().toISOString();
      const likeCount = getLastLikeCount();
      db.prepare(`
        INSERT OR REPLACE INTO client_channel_snapshots (polled_at, live_viewers, like_count, live_video_id)
        VALUES (?, NULL, ?, NULL)
      `).run(now, likeCount);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] live_detect_failed reason=${message}`);
  }
}

export function startLivePoller(): void {
  void detectLive();
  setInterval(() => {
    if (currentChannelId !== env.CLIENT_CHANNEL_ID) void detectLive();
  }, 5_000);
  setInterval(() => void detectLive(), 60 * 60 * 1000);
}
