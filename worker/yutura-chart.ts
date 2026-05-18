// Per-channel chart poller. Visits yutura's /channel/{yuturaId}/chart/ page
// for every active channel, parses the 30-day count-table, and merges the
// rows into subscriber_snapshots. With one row per day per channel this is
// the data backbone of the Phase C milestone-based growth rate calculation.
//
// Cadence: 1/day. Roughly N(active) HTTP requests per sweep (≈150 for TOP150)
// with YUTURA_REQUEST_DELAY_MS between each. At 1500ms delay that is ~4 min.

import db from '@/lib/db';
import { env } from '@/lib/env';
import { parseChartTable } from '@/lib/yutura-chart-parser';
import { BASE_URL, destroyFlaresolverrSession, fetchHtml, sleep } from './yutura-fetch';

interface ChannelTarget {
  id: string;
  source_id: string;
}

function listActiveYuturaChannels(): ChannelTarget[] {
  return db.prepare(`
    SELECT id, source_id
    FROM   channels
    WHERE  is_active = 1
      AND  source_id IS NOT NULL
    ORDER  BY last_seen_at DESC
  `).all() as ChannelTarget[];
}

export async function pollYuturaChartHistory(): Promise<void> {
  const startedAt = new Date().toISOString();
  const targets = listActiveYuturaChannels();

  if (targets.length === 0) {
    // No-op without logging — pollYutura hasn't populated channels yet on a
    // fresh DB. If we wrote a 'success' row here, isDue would skip chart for
    // the next 24h while channels finish landing. Letting the next 60s tick
    // re-check picks the job up as soon as pollYutura finishes (~225s sweep).
    console.log('[worker] yutura_chart_skip reason=no_active_channels');
    return;
  }

  const insertSnapshot = db.prepare(`
    INSERT INTO subscriber_snapshots
      (channel_id, polled_at, subscriber_count, video_count, view_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, polled_at) DO UPDATE SET
      subscriber_count = excluded.subscriber_count,
      video_count      = COALESCE(excluded.video_count, subscriber_snapshots.video_count),
      view_count       = COALESCE(excluded.view_count,  subscriber_snapshots.view_count)
  `);

  const writeChannel = db.transaction((channelId: string, rows: ReturnType<typeof parseChartTable>) => {
    let count = 0;
    for (const r of rows) {
      insertSnapshot.run(channelId, r.date, r.subscriberCount, r.videoCount, r.viewCount);
      count++;
    }
    return count;
  });

  let okChannels = 0;
  let failChannels = 0;
  let totalRows = 0;
  let emptyChannels = 0;

  try {
    for (const t of targets) {
      const url = `${BASE_URL}/channel/${t.source_id}/chart/`;
      try {
        const html = await fetchHtml(url, `${BASE_URL}/channel/${t.source_id}/`);
        const rows = parseChartTable(html);
        if (rows.length === 0) {
          emptyChannels++;
          console.log(
            `[worker] yutura_chart_empty channel_id=${t.id} yutura_id=${t.source_id}`,
          );
        } else {
          const inserted = writeChannel(t.id, rows);
          totalRows += inserted;
          okChannels++;
        }
      } catch (err) {
        failChannels++;
        const message = err instanceof Error ? err.message : String(err);
        console.log(
          `[worker] yutura_chart_fetch_error channel_id=${t.id} yutura_id=${t.source_id} reason=${message}`,
        );
      }
      await sleep(env.YUTURA_REQUEST_DELAY_MS);
    }

    const durationMs = Date.now() - new Date(startedAt).getTime();
    console.log(
      `[worker] yutura_chart_success channels_ok=${okChannels} channels_fail=${failChannels} ` +
        `channels_empty=${emptyChannels} rows=${totalRows} duration_ms=${durationMs}`,
    );
    db.prepare(
      `INSERT INTO chart_pulls (kind, pulled_at, status, channels_count, rows_inserted)
       VALUES ('chart', ?, ?, ?, ?)`,
    ).run(
      startedAt,
      failChannels > okChannels ? 'failed' : 'success',
      okChannels,
      totalRows,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] yutura_chart_failed reason=${message}`);
    db.prepare(
      `INSERT INTO chart_pulls (kind, pulled_at, status, channels_count, rows_inserted, error)
       VALUES ('chart', ?, 'failed', ?, ?, ?)`,
    ).run(startedAt, okChannels, totalRows, message);
  } finally {
    await destroyFlaresolverrSession();
  }
}

// Triggers the monthly ranking page from ~60 days ago. The ranking page only
// returns the TOP listing for that month, so channels that weren't in the top
// at that time won't get a -60d data point — for those the snapshot.ts trend
// SQL falls through to the "oldest available" branch, which is acceptable.
export async function backfillSixtyDaySnapshots(): Promise<void> {
  const { backfillYuturaMonthlySnapshots } = await import('./yutura');
  const month = monthOffsetUtc(new Date(), -2);
  const startedAt = new Date().toISOString();
  try {
    console.log(`[worker] yutura_60d_backfill_start month=${month}`);
    await backfillYuturaMonthlySnapshots(month);
    const beforeCount = countSnapshotsAtMonth(month);
    db.prepare(
      `INSERT INTO chart_pulls (kind, pulled_at, status, channels_count, rows_inserted)
       VALUES ('monthly_backfill', ?, 'success', NULL, ?)`,
    ).run(startedAt, beforeCount);
    console.log(`[worker] yutura_60d_backfill_done month=${month} rows=${beforeCount}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] yutura_60d_backfill_failed month=${month} reason=${message}`);
    db.prepare(
      `INSERT INTO chart_pulls (kind, pulled_at, status, error)
       VALUES ('monthly_backfill', ?, 'failed', ?)`,
    ).run(startedAt, message);
  }
}

// Computes YYYYMM offset months from `from` in UTC. `monthsDelta` is signed
// (negative = past). Used to ask backfillYuturaMonthlySnapshots for the
// "~60 days ago" month (delta = -2 from current month).
function monthOffsetUtc(from: Date, monthsDelta: number): string {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + monthsDelta; // 0-indexed, may go negative
  const target = new Date(Date.UTC(y, m, 1));
  const yy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}${mm}`;
}

function countSnapshotsAtMonth(month: string): number {
  const polledAt = `${month.slice(0, 4)}-${month.slice(4, 6)}-01T00:00:00.000Z`;
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM subscriber_snapshots WHERE polled_at = ?',
  ).get(polledAt) as { n: number };
  return row.n;
}
