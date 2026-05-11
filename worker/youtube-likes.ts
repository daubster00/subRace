import { z } from 'zod';
import db from '@/lib/db';
import { env } from '@/lib/env';

const VideoStatsSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    statistics: z.object({
      likeCount: z.string().optional(),
    }),
  })).default([]),
});

const LatestVideoSchema = z.object({
  items: z.array(z.object({
    id: z.object({ videoId: z.string() }),
  })).default([]),
});

async function findLikeTargetVideoId(): Promise<string | null> {
  const lastLive = db.prepare(
    'SELECT live_video_id FROM client_channel_snapshots WHERE live_video_id IS NOT NULL ORDER BY polled_at DESC LIMIT 1'
  ).get() as { live_video_id: string } | undefined;

  if (lastLive) {
    return lastLive.live_video_id;
  }

  const url = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${env.CLIENT_CHANNEL_ID}&type=video&order=date&maxResults=1&key=${env.YOUTUBE_API_KEY}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`http_error status=${response.status}`);

  const raw = await response.json() as unknown;
  const parsed = LatestVideoSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`zod_validation_failed: ${parsed.error.message}`);

  return parsed.data.items[0]?.id.videoId ?? null;
}

export async function pollYoutubeLikes(): Promise<void> {
  const now = new Date().toISOString();
  try {
    const videoId = await findLikeTargetVideoId();

    if (!videoId) {
      return;
    }

    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${env.YOUTUBE_API_KEY}`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`http_error status=${response.status}`);

    const raw = await response.json() as unknown;
    const parsed = VideoStatsSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`zod_validation_failed: ${parsed.error.message}`);

    const item = parsed.data.items[0];
    const likeCount = item?.statistics?.likeCount ? parseInt(item.statistics.likeCount, 10) : 0;

    const existingRow = db.prepare(
      'SELECT polled_at FROM client_channel_snapshots ORDER BY polled_at DESC LIMIT 1'
    ).get() as { polled_at: string } | undefined;

    if (existingRow) {
      db.prepare('UPDATE client_channel_snapshots SET like_count = ? WHERE polled_at = ?').run(likeCount, existingRow.polled_at);
    } else {
      db.prepare(`
        INSERT OR REPLACE INTO client_channel_snapshots (polled_at, live_viewers, like_count, live_video_id)
        VALUES (?, NULL, ?, ?)
      `).run(now, likeCount, videoId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] likes_poll_failed reason=${message}`);
  }
}
