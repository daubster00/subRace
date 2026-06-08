import { z } from 'zod';
import db from '@/lib/db';
import { env } from '@/lib/env';
import { getBuildId } from '@/lib/build-id';

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
  // Forward-projected count "as of serverTime" using growthRatePerHour and
  // ESTIMATION_SAFETY_RATIO — same formula the client interpolation hook uses.
  // Lets the first paint (SSR / cold tab) start at a natural drifted value
  // instead of snapping to the stale polled value.
  estimatedSubscriberCount: z.number().int(),
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
  // 마지막 표시값 변경 방향/시각 (display_state). 사전 스케줄 executor가 매 step
  // 갱신. M6 클라이언트 단순화 시 모션(상승/하락 테두리·화살표)을 이 서버값으로
  // 구동한다 — 클라 랜덤 드리프트 제거 후 방향 정보 출처 (지뢰③).
  lastChangeDirection: z.enum(['up', 'down']).nullable(),
  lastChangedAt:       z.string().nullable(),
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
  // .next/BUILD_ID. 클라이언트가 첫 응답값을 baseline으로 저장하고, 이후 폴링
  // 응답마다 비교 → 다르면 location.reload(). SSE auto-reload(/api/events)의
  // 폴백: 일부 환경(탭 freeze, 프록시 keep-alive 등)에서 EventSource 재연결이
  // 느리거나 누락되어도 30초 폴 주기 내에 자동 갱신을 보장한다.
  buildId: z.string(),
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
  last_change_direction: string | null;
  last_changed_at:  string | null;
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
  //
  // 표시값은 display_state.display_subscriber_count를 1순위로 쓰고, 행이 없는
  // 채널(planner가 아직 시드 안 함)만 마일스톤 최신값으로 fallback. polled_at도
  // 동일 — display_state.updated_at이 hook의 forward-projection 기준 시각이
  // 되어, executor가 박은 step 값 그대로가 화면에 도달한다.
  //
  // trend_baseline_*, surge_baseline_*, previous_subscriber_count는 장기 추세
  // 비교용이라 마일스톤 history(subscriber_snapshots) 그대로 사용.
  //
  // surge_baseline_count: julianday(latest) - julianday(baseline) >= 1.0 → at
  // least 24h gap. Most recent snapshot satisfying that constraint becomes the
  // 24h baseline. NULL when the channel does not yet have 24h of history.
  const channelRows = db.prepare(`
    SELECT
      c.id,
      c.handle,
      c.name,
      c.thumbnail_url,
      COALESCE(d.display_subscriber_count, s.subscriber_count, 0) AS subscriber_count,
      (
        SELECT ss_prev.subscriber_count
        FROM   subscriber_snapshots ss_prev
        WHERE  ss_prev.channel_id = c.id
          AND  s.polled_at IS NOT NULL
          AND  ss_prev.polled_at < s.polled_at
        ORDER  BY ss_prev.polled_at DESC
        LIMIT  1
      ) AS previous_subscriber_count,
      -- Phase C: 30-day-active 우선, 30일 정체면 60일 baseline.
      --
      -- 1차) 30일 이상 떨어진 스냅샷 중 현재와 카운트가 다른 가장 최근 행.
      --      현재가 3.24M인데 35일 전이 3.23M이면 채널은 그동안 transition을
      --      한 번 했고, growthRate는 +10k / 35d 로 정확하게 잡힌다.
      -- 2차) 60일 이상 떨어진 가장 최근 행. 1차가 NULL = 30일 내내 같은 카운트.
      --      더 멀리 보면 직전 transition을 잡을 수 있다. 이게 사용자가 요구한
      --      "30일 안에 변화가 없는 채널이 있다면 60일 이전 구독자 수" 분기.
      -- 3차) 가장 오래된 스냅샷 (60일치 데이터가 아직 없는 신규 채널).
      --
      -- 세 분기의 WHERE/ORDER는 _count와 _at subquery가 동일해 같은 행을 선택.
      COALESCE(
        (
          SELECT ss_t.subscriber_count
          FROM   subscriber_snapshots ss_t
          WHERE  ss_t.channel_id = c.id
            AND  s.polled_at IS NOT NULL
            AND  julianday(s.polled_at) - julianday(ss_t.polled_at) >= 30.0
            AND  ss_t.subscriber_count != s.subscriber_count
          ORDER  BY ss_t.polled_at DESC
          LIMIT  1
        ),
        (
          SELECT ss_60.subscriber_count
          FROM   subscriber_snapshots ss_60
          WHERE  ss_60.channel_id = c.id
            AND  s.polled_at IS NOT NULL
            AND  julianday(s.polled_at) - julianday(ss_60.polled_at) >= 60.0
          ORDER  BY ss_60.polled_at DESC
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
          SELECT ss_t.polled_at
          FROM   subscriber_snapshots ss_t
          WHERE  ss_t.channel_id = c.id
            AND  s.polled_at IS NOT NULL
            AND  julianday(s.polled_at) - julianday(ss_t.polled_at) >= 30.0
            AND  ss_t.subscriber_count != s.subscriber_count
          ORDER  BY ss_t.polled_at DESC
          LIMIT  1
        ),
        (
          SELECT ss_60.polled_at
          FROM   subscriber_snapshots ss_60
          WHERE  ss_60.channel_id = c.id
            AND  s.polled_at IS NOT NULL
            AND  julianday(s.polled_at) - julianday(ss_60.polled_at) >= 60.0
          ORDER  BY ss_60.polled_at DESC
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
      COALESCE(d.updated_at, s.polled_at) AS polled_at,
      d.last_change_direction,
      d.last_changed_at
    FROM channels c
    LEFT JOIN subscriber_snapshots s
      ON  s.channel_id = c.id
      AND s.polled_at  = (
            SELECT MAX(ss.polled_at)
            FROM   subscriber_snapshots ss
            WHERE  ss.channel_id = c.id
          )
    LEFT JOIN display_state d
      ON  d.channel_id = c.id
    WHERE c.is_active = 1
    ORDER BY COALESCE(d.display_subscriber_count, s.subscriber_count, 0) DESC
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

    // M5: display_state.display_subscriber_count가 이미 executor가 매 step마다
    // 갱신한 "현재 표시값"이라 server-side forward-projection은 중복이자, 음수
    // growthRate 채널에선 시간 흐를수록 화면이 감소 방향으로 끌려가는 부작용을
    // 만든다. 그대로 노출.
    const estimatedSubscriberCount = row.subscriber_count;

    return {
      id:              row.id,
      handle:          row.handle,
      name:            row.name,
      thumbnailUrl:    row.thumbnail_url,
      subscriberCount: row.subscriber_count,
      estimatedSubscriberCount,
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
      lastChangeDirection:
        row.last_change_direction === 'up' || row.last_change_direction === 'down'
          ? row.last_change_direction
          : null,
      lastChangedAt:   row.last_changed_at ?? null,
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
    buildId: getBuildId(),
  };
}
