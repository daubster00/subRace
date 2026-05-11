import { z } from 'zod';
import db from '@/lib/db';
import { env } from '@/lib/env';

const YtChannelItemSchema = z.object({
  id: z.string(),
  snippet: z.object({
    thumbnails: z.object({
      medium: z.object({ url: z.string() }).optional(),
      default: z.object({ url: z.string() }).optional(),
    }).optional(),
  }).optional(),
  statistics: z.object({
    subscriberCount: z.string(),
    videoCount: z.string().optional(),
    viewCount: z.string().optional(),
  }),
});

const YtChannelsResponseSchema = z.object({
  items: z.array(YtChannelItemSchema).default([]),
});

type YtChannelItem = z.infer<typeof YtChannelItemSchema>;

async function fetchChunk(channelIds: string[]): Promise<YtChannelItem[]> {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${channelIds.join(',')}&key=${env.YOUTUBE_API_KEY}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });

  if (response.status === 403) {
    const body = await response.json() as { error?: { errors?: { reason?: string }[] } };
    const reason = body?.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded') {
      throw new Error(`quota_exceeded reason=${reason}`);
    }
    throw new Error(`http_error status=403`);
  }

  if (!response.ok) {
    throw new Error(`http_error status=${response.status}`);
  }

  const raw = await response.json() as unknown;
  const parsed = YtChannelsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`zod_validation_failed: ${parsed.error.message}`);
  }

  return parsed.data.items;
}

export async function pollYoutubeChannels(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const channelRows = db.prepare(
      'SELECT id FROM channels WHERE is_active = 1 LIMIT ?'
    ).all(env.BACKGROUND_LIMIT) as { id: string }[];

    const polledAt = startedAt;
    let isQuotaExceeded = false;
    const items: YtChannelItem[] = [];

    for (let i = 0; i < channelRows.length; i += 50) {
      const chunk = channelRows.slice(i, i + 50);
      try {
        items.push(...await fetchChunk(chunk.map(r => r.id)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('quota_exceeded')) {
          isQuotaExceeded = true;
          console.log(`[worker] youtube_poll_failed reason=quota_exceeded next_retry_at=${new Date(Date.now() + env.YOUTUBE_POLL_INTERVAL_HOURS * 3600 * 1000).toISOString()}`);
          db.prepare('INSERT INTO youtube_polls (polled_at, status, error) VALUES (?, ?, ?)').run(startedAt, 'quota_exceeded', message);
          return;
        }
        throw err;
      }
    }

    if (!isQuotaExceeded) {
      const insertSnapshot = db.prepare(`
        INSERT OR IGNORE INTO subscriber_snapshots
          (channel_id, polled_at, subscriber_count, video_count, view_count)
        VALUES (?, ?, ?, ?, ?)
      `);
      const updateThumbnail = db.prepare(`
        UPDATE channels SET thumbnail_url = ? WHERE id = ? AND thumbnail_url IS NULL
      `);

      const commitSuccess = db.transaction((snapshotItems: YtChannelItem[]) => {
        for (const item of snapshotItems) {
          insertSnapshot.run(
            item.id,
            polledAt,
            parseInt(item.statistics.subscriberCount, 10),
            item.statistics.videoCount ? parseInt(item.statistics.videoCount, 10) : null,
            item.statistics.viewCount ? parseInt(item.statistics.viewCount, 10) : null,
          );

          const thumbnailUrl =
            item.snippet?.thumbnails?.medium?.url ??
            item.snippet?.thumbnails?.default?.url ??
            null;
          if (thumbnailUrl) {
            updateThumbnail.run(thumbnailUrl, item.id);
          }
        }
        db.prepare('INSERT INTO youtube_polls (polled_at, status, channels_count) VALUES (?, ?, ?)')
          .run(startedAt, 'success', channelRows.length);
      });
      commitSuccess(items);

      const n = channelRows.length;
      const durationMs = Date.now() - new Date(startedAt).getTime();
      console.log(`[worker] youtube_poll_success channels=${n} duration_ms=${durationMs}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] youtube_poll_failed reason=${message}`);
    db.prepare('INSERT INTO youtube_polls (polled_at, status, error) VALUES (?, ?, ?)').run(startedAt, 'failed', message);
  }
}
