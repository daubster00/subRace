import { z } from 'zod';
import db from '@/lib/db';
import { env } from '@/lib/env';
import { getNextMilestone } from '@/lib/next-milestone';
import { computeCap } from '@/lib/cap';
import { onNewMilestone } from './channel-scheduler';

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
      // M2: 변경분만 milestone 누적 + poll_state upsert.
      //
      // - 신규 채널: 마일스톤 INSERT + poll_state 시드 (previous=NULL,
      //   last_api_changed_at=polledAt — 첫 관측 시각을 기준값으로).
      // - API 값 변동 없음: poll_state.last_polled_at만 갱신.
      //   subscriber_snapshots는 손대지 않음 → unique index가 막아주기 전에
      //   상위 레벨에서 차단.
      // - API 값 변동: 마일스톤 INSERT (source='youtube_api_change') +
      //   poll_state UPDATE (previous=기존 api, api=새 값, next_milestone/cap
      //   재계산, last_api_changed_at=polledAt).
      const selectPollState = db.prepare(`
        SELECT api_subscriber_count FROM poll_state WHERE channel_id = ?
      `);
      const insertMilestone = db.prepare(`
        INSERT OR IGNORE INTO subscriber_snapshots
          (channel_id, polled_at, subscriber_count, video_count, view_count, source)
        VALUES (?, ?, ?, ?, ?, 'youtube_api_change')
      `);
      const insertPollState = db.prepare(`
        INSERT INTO poll_state (
          channel_id, api_subscriber_count, previous_api_subscriber_count,
          next_milestone, cap_subscriber_count,
          last_polled_at, last_api_changed_at, updated_at, created_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `);
      // SQLite는 UPDATE의 RHS를 원본 컬럼값으로 평가하므로
      // previous = api_subscriber_count, api = ? 가 안전하다.
      const updatePollStateChanged = db.prepare(`
        UPDATE poll_state SET
          previous_api_subscriber_count = api_subscriber_count,
          api_subscriber_count          = ?,
          next_milestone                = ?,
          cap_subscriber_count          = ?,
          last_polled_at                = ?,
          last_api_changed_at           = ?,
          updated_at                    = ?
        WHERE channel_id = ?
      `);
      const updatePollStateUnchanged = db.prepare(`
        UPDATE poll_state SET
          last_polled_at = ?,
          updated_at     = ?
        WHERE channel_id = ?
      `);
      const updateThumbnail = db.prepare(`
        UPDATE channels SET thumbnail_url = ? WHERE id = ? AND thumbnail_url IS NULL
      `);

      let seededCount = 0;
      let changedCount = 0;
      let unchangedCount = 0;
      // 새 마일스톤이 기록된 채널(시드 또는 변경) — 커밋 후 즉시 재계획 트리거.
      const milestoneChannelIds: string[] = [];

      const commitSuccess = db.transaction((snapshotItems: YtChannelItem[]) => {
        for (const item of snapshotItems) {
          const apiCount = parseInt(item.statistics.subscriberCount, 10);
          const videoCount = item.statistics.videoCount ? parseInt(item.statistics.videoCount, 10) : null;
          const viewCount = item.statistics.viewCount ? parseInt(item.statistics.viewCount, 10) : null;

          const existing = selectPollState.get(item.id) as { api_subscriber_count: number } | undefined;

          if (!existing) {
            const nextMilestone = getNextMilestone(apiCount);
            const cap = computeCap(apiCount, env.ESTIMATION_SAFETY_RATIO);
            insertMilestone.run(item.id, polledAt, apiCount, videoCount, viewCount);
            insertPollState.run(
              item.id, apiCount, nextMilestone, cap,
              polledAt, polledAt, polledAt, polledAt,
            );
            seededCount++;
            milestoneChannelIds.push(item.id);
          } else if (existing.api_subscriber_count === apiCount) {
            updatePollStateUnchanged.run(polledAt, polledAt, item.id);
            unchangedCount++;
          } else {
            const nextMilestone = getNextMilestone(apiCount);
            const cap = computeCap(apiCount, env.ESTIMATION_SAFETY_RATIO);
            insertMilestone.run(item.id, polledAt, apiCount, videoCount, viewCount);
            updatePollStateChanged.run(
              apiCount, nextMilestone, cap,
              polledAt, polledAt, polledAt,
              item.id,
            );
            changedCount++;
            milestoneChannelIds.push(item.id);
          }

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

      // 새 마일스톤 채널 즉시 재계획 (catch-up). 커밋 이후라 planOneChannel이
      // 읽는 poll_state/마일스톤이 최신 상태.
      for (const id of milestoneChannelIds) onNewMilestone(id);

      const n = channelRows.length;
      const durationMs = Date.now() - new Date(startedAt).getTime();
      console.log(`[worker] youtube_poll_success channels=${n} seeded=${seededCount} changed=${changedCount} unchanged=${unchangedCount} duration_ms=${durationMs}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] youtube_poll_failed reason=${message}`);
    db.prepare('INSERT INTO youtube_polls (polled_at, status, error) VALUES (?, ?, ?)').run(startedAt, 'failed', message);
  }
}
