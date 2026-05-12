import { z } from 'zod';
import db from '@/lib/db';
import { env } from '@/lib/env';

// ---------- Zod 응답 스키마 (AC3) ----------

const SourceStatusSchema = z.object({
  ok:            z.boolean(),
  lastSuccessAt: z.string().nullable(),
});

const ChannelSchema = z.object({
  id:              z.string(),
  handle:          z.string().nullable(),
  name:            z.string(),
  thumbnailUrl:    z.string().nullable(),
  subscriberCount: z.number().int(),
  previousSubscriberCount: z.number().int().nullable(),
  videoCount:      z.number().int().nullable(),
  viewCount:       z.number().int().nullable(),
  snapshottedAt:   z.string(),
  rank:            z.number().int().positive(),
  // Trend baseline: prefer a snapshot at least ~1 month old; if unavailable,
  // use the oldest available snapshot before the current one.
  trendBaselineSubscriberCount: z.number().int().nullable(),
  trendBaselineAt: z.string().nullable(),
  trendDelta:      z.number().int().nullable(),
  growthRatePerHour: z.number().nullable(),
  // Surge metrics use the configurable window, currently 24h in production.
  surgeDelta24h:   z.number().int().nullable(),
  surgeRate24h:    z.number().nullable(),
});

const ClientChannelSchema = z.object({
  liveViewers:      z.number().int().nullable(),
  likeCount:        z.number().int(),
  lastLivePolledAt: z.string().nullable(),
});

export const SnapshotResponseSchema = z.object({
  channels:      z.array(ChannelSchema),
  clientChannel: ClientChannelSchema,
  status: z.object({
    yutura: SourceStatusSchema,
    youtube:     SourceStatusSchema,
    live:        SourceStatusSchema,
  }),
  serverTime: z.string(),
});

export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
export type Channel          = z.infer<typeof ChannelSchema>;
export type ClientChannel    = z.infer<typeof ClientChannelSchema>;

// ---------- DB row 타입 (snake_case) — 외부 노출 금지 ----------

interface ChannelRow {
  id:               string;
  handle:           string | null;
  name:             string;
  thumbnail_url:    string | null;
  subscriber_count: number;
  previous_subscriber_count: number | null;
  trend_baseline_count: number | null;
  trend_baseline_at: string | null;
  surge_baseline_count: number | null;
  video_count:      number | null;
  view_count:       number | null;
  polled_at:        string | null;
}

interface ClientRow {
  polled_at:    string;
  live_viewers: number | null;
  like_count:   number | null;
}

interface StatusRow {
  status: string;
}

interface LastSuccessRow {
  last_success: string | null;
}

// ---------- 단일 공개 함수 ----------

export function readSnapshot(): SnapshotResponse {
  // 1. 채널 + 최신 구독자 스냅샷 (LEFT JOIN — 빈 DB 대응)
  // surge_baseline_count: julianday(latest) - julianday(baseline) >= 1.0 → at
  // least 24h gap. Most recent snapshot satisfying that constraint becomes the
  // 24h baseline. NULL when the channel does not yet have 24h of history.
  const channelRows = db.prepare(`
    SELECT
      c.id,
      c.handle,
      c.name,
      c.thumbnail_url,
      COALESCE(s.subscriber_count, 0) AS subscriber_count,
      (
        SELECT ss_prev.subscriber_count
        FROM   subscriber_snapshots ss_prev
        WHERE  ss_prev.channel_id = c.id
          AND  s.polled_at IS NOT NULL
          AND  ss_prev.polled_at < s.polled_at
        ORDER  BY ss_prev.polled_at DESC
        LIMIT  1
      ) AS previous_subscriber_count,
      COALESCE(
        (
          SELECT ss_month.subscriber_count
          FROM   subscriber_snapshots ss_month
          WHERE  ss_month.channel_id = c.id
            AND  s.polled_at IS NOT NULL
            AND  julianday(s.polled_at) - julianday(ss_month.polled_at) >= 30.0
          ORDER  BY ss_month.polled_at DESC
          LIMIT  1
        ),
        (
          SELECT ss_old.subscriber_count
          FROM   subscriber_snapshots ss_old
          WHERE  ss_old.channel_id = c.id
            AND  s.polled_at IS NOT NULL
            AND  ss_old.polled_at < s.polled_at
          ORDER  BY ss_old.polled_at ASC
          LIMIT  1
        )
      ) AS trend_baseline_count,
      COALESCE(
        (
          SELECT ss_month.polled_at
          FROM   subscriber_snapshots ss_month
          WHERE  ss_month.channel_id = c.id
            AND  s.polled_at IS NOT NULL
            AND  julianday(s.polled_at) - julianday(ss_month.polled_at) >= 30.0
          ORDER  BY ss_month.polled_at DESC
          LIMIT  1
        ),
        (
          SELECT ss_old.polled_at
          FROM   subscriber_snapshots ss_old
          WHERE  ss_old.channel_id = c.id
            AND  s.polled_at IS NOT NULL
            AND  ss_old.polled_at < s.polled_at
          ORDER  BY ss_old.polled_at ASC
          LIMIT  1
        )
      ) AS trend_baseline_at,
      (
        SELECT ss_24h.subscriber_count
        FROM   subscriber_snapshots ss_24h
        WHERE  ss_24h.channel_id = c.id
          AND  s.polled_at IS NOT NULL
          AND  julianday(s.polled_at) - julianday(ss_24h.polled_at) >= ?
        ORDER  BY ss_24h.polled_at DESC
        LIMIT  1
      ) AS surge_baseline_count,
      s.video_count,
      s.view_count,
      s.polled_at
    FROM channels c
    LEFT JOIN subscriber_snapshots s
      ON  s.channel_id = c.id
      AND s.polled_at  = (
            SELECT MAX(ss.polled_at)
            FROM   subscriber_snapshots ss
            WHERE  ss.channel_id = c.id
          )
    WHERE c.is_active = 1
    ORDER BY COALESCE(s.subscriber_count, 0) DESC
    LIMIT ?
  `).all(env.SURGE_WINDOW_HOURS / 24, env.DISPLAY_LIMIT) as ChannelRow[];

  const channels: Channel[] = channelRows.map((row, i) => {
    const baseline = row.surge_baseline_count;
    const surgeDelta = baseline != null && baseline > 0
      ? row.subscriber_count - baseline
      : null;
    const surgeRate = baseline != null && baseline > 0
      ? (row.subscriber_count - baseline) / baseline
      : null;
    const trendBaseline = row.trend_baseline_count;
    const trendBaselineAt = row.trend_baseline_at;
    const trendHours =
      trendBaseline != null && trendBaselineAt && row.polled_at
        ? (new Date(row.polled_at).getTime() - new Date(trendBaselineAt).getTime()) / 3_600_000
        : null;
    const trendDelta = trendBaseline != null && trendHours != null && trendHours > 0
      ? row.subscriber_count - trendBaseline
      : null;
    const growthRatePerHour = trendDelta != null && trendHours != null && trendHours > 0
      ? trendDelta / trendHours
      : null;

    return {
      id:              row.id,
      handle:          row.handle,
      name:            row.name,
      thumbnailUrl:    row.thumbnail_url,
      subscriberCount: row.subscriber_count,
      previousSubscriberCount: row.previous_subscriber_count ?? null,
      videoCount:      row.video_count ?? null,
      viewCount:       row.view_count ?? null,
      snapshottedAt:   row.polled_at ?? new Date().toISOString(),
      rank:            i + 1,
      trendBaselineSubscriberCount: trendBaseline ?? null,
      trendBaselineAt: trendBaselineAt ?? null,
      trendDelta,
      growthRatePerHour,
      surgeDelta24h:   surgeDelta,
      surgeRate24h:    surgeRate,
    };
  });

  // 2. 클라이언트 채널 최신 1행 — 현재 CLIENT_CHANNEL_ID 의 스냅샷만.
  // 채널 ID를 바꾸면 이전 채널의 행은 ignore 되어 SummaryCard 가 잔재 데이터를
  // 보여주지 않는다. 새 채널의 데이터가 들어올 때까지는 빈 상태로 표시된다.
  const clientRow = db.prepare(`
    SELECT polled_at, live_viewers, like_count
    FROM   client_channel_snapshots
    WHERE  channel_id = ?
    ORDER  BY polled_at DESC
    LIMIT  1
  `).get(env.CLIENT_CHANNEL_ID) as ClientRow | undefined;

  const clientChannel: ClientChannel = {
    liveViewers:      clientRow?.live_viewers   ?? null,
    likeCount:        clientRow?.like_count      ?? 0,
    lastLivePolledAt: clientRow?.polled_at       ?? null,
  };

  // 3. yutura 상태 (pulled_at 컬럼)
  const yuturaLatest = db.prepare(`
    SELECT status FROM yutura_pulls ORDER BY id DESC LIMIT 1
  `).get() as StatusRow | undefined;

  const yuturaLastSuccess = db.prepare(`
    SELECT MAX(pulled_at) AS last_success
    FROM   yutura_pulls
    WHERE  status = 'success'
  `).get() as LastSuccessRow;

  // 4. YouTube 폴링 상태 (polled_at 컬럼)
  const ytLatest = db.prepare(`
    SELECT status FROM youtube_polls ORDER BY id DESC LIMIT 1
  `).get() as StatusRow | undefined;

  const ytLastSuccess = db.prepare(`
    SELECT MAX(polled_at) AS last_success
    FROM   youtube_polls
    WHERE  status = 'success'
  `).get() as LastSuccessRow;

  // 5. 라이브 폴링 상태
  // detectLive는 1시간마다 실행되므로 창을 70분으로 설정
  const liveOkWindow = 70 * 60 * 1000;
  const liveOk =
    clientRow !== undefined &&
    Date.now() - new Date(clientRow.polled_at).getTime() < liveOkWindow;

  return {
    channels,
    clientChannel,
    status: {
      yutura: {
        ok:            yuturaLatest?.status === 'success',
        lastSuccessAt: yuturaLastSuccess.last_success ?? null,
      },
      youtube: {
        ok:            ytLatest?.status === 'success',
        lastSuccessAt: ytLastSuccess.last_success ?? null,
      },
      live: {
        ok:            liveOk,
        lastSuccessAt: clientRow?.polled_at ?? null,
      },
    },
    serverTime: new Date().toISOString(),
  };
}
