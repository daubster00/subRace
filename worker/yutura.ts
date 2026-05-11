import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import db from '@/lib/db';
import { env } from '@/lib/env';

const execFileP = promisify(execFile);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PAGE_COUNT = 8;
const BASE_URL = 'https://yutura.net';
const FETCH_TIMEOUT_SECONDS = 30;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

interface ListEntry {
  rank: number;
  yuturaId: string;
  name: string;
  thumbnailUrl: string | null;
  subscriberCount: number | null;
}

interface ResolvedChannel extends ListEntry {
  youtubeChannelId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// yutura is behind Cloudflare, which blocks Node's fetch on TLS fingerprint
// (JA3/JA4) even with browser-matching headers. Two strategies, picked by env:
//   1. FLARESOLVERR_URL set → route through FlareSolverr, which drives a real
//      Chrome via undetected-chromedriver and can solve JS challenges that
//      curl-impersonate cannot. Required when the server IP triggers a
//      Managed Challenge (typical on datacenter/VPS ranges).
//   2. Otherwise → shell out to curl-impersonate (YUTURA_CURL_BIN), which
//      passes the JA3/JA4 check but cannot solve a JS challenge.
const CURL_BIN = process.env.YUTURA_CURL_BIN ?? 'curl';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL;
const FLARESOLVERR_TIMEOUT_MS = 60_000;

let flaresolverrSession: string | null = null;

interface FlaresolverrResponse {
  status: string;
  message?: string;
  session?: string;
  solution?: {
    url: string;
    status: number;
    response: string;
  };
}

async function flaresolverrCall(
  cmd: string,
  params: Record<string, unknown> = {},
): Promise<FlaresolverrResponse> {
  const res = await fetch(`${FLARESOLVERR_URL}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, maxTimeout: FLARESOLVERR_TIMEOUT_MS, ...params }),
    signal: AbortSignal.timeout(FLARESOLVERR_TIMEOUT_MS + 5_000),
  });
  if (!res.ok) {
    throw new Error(`flaresolverr_http_error status=${res.status}`);
  }
  const data = (await res.json()) as FlaresolverrResponse;
  if (data.status !== 'ok') {
    throw new Error(`flaresolverr_error message="${data.message ?? 'unknown'}"`);
  }
  return data;
}

async function ensureFlaresolverrSession(): Promise<string> {
  if (flaresolverrSession) return flaresolverrSession;
  const data = await flaresolverrCall('sessions.create');
  if (!data.session) throw new Error('flaresolverr_no_session_returned');
  flaresolverrSession = data.session;
  return flaresolverrSession;
}

async function destroyFlaresolverrSession(): Promise<void> {
  if (!flaresolverrSession) return;
  const sid = flaresolverrSession;
  flaresolverrSession = null;
  try {
    await flaresolverrCall('sessions.destroy', { session: sid });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] flaresolverr_session_destroy_failed reason=${message}`);
  }
}

async function fetchViaFlaresolverr(url: string): Promise<string> {
  const session = await ensureFlaresolverrSession();
  const data = await flaresolverrCall('request.get', { url, session });
  const sol = data.solution;
  if (!sol) throw new Error(`yutura_http_error url=${url} reason=no_solution`);
  if (sol.status >= 400) {
    throw new Error(`yutura_http_error url=${url} status=${sol.status}`);
  }
  return sol.response;
}

async function fetchViaCurl(url: string, referer?: string): Promise<string> {
  const args = [
    '--silent',
    '--show-error',
    '--fail-with-body',
    '--compressed',
    '--max-time', String(FETCH_TIMEOUT_SECONDS),
    '--max-filesize', String(MAX_RESPONSE_BYTES),
    '-A', USER_AGENT,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: ja,en;q=0.7',
  ];
  if (referer) args.push('-H', `Referer: ${referer}`);
  args.push(url);

  try {
    const { stdout } = await execFileP(CURL_BIN, args, {
      maxBuffer: MAX_RESPONSE_BYTES,
      encoding: 'utf-8',
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stderr?: string };
    if (e.code === 'ENOENT') {
      throw new Error('curl_not_found install_curl_on_host');
    }
    const status = typeof e.code === 'number' ? e.code : 'unknown';
    throw new Error(`yutura_http_error url=${url} curl_exit=${status}`);
  }
}

async function fetchHtml(url: string, referer?: string): Promise<string> {
  if (FLARESOLVERR_URL) return fetchViaFlaresolverr(url);
  return fetchViaCurl(url, referer);
}

// Each ranking row is a single <li id="rankN"> ... </li> block. The block
// contains a thumbnail <img>, a <p class="title">, and the detail-page link
// /channel/{yuturaId}/. We parse defensively so a malformed row gets skipped
// rather than poisoning the batch.
const LIST_ITEM_RE =
  /<li id="rank(\d+)">([\s\S]*?)<\/li>/g;
const THUMB_RE =
  /<p class="thumbnail">.*?<img[^>]*src="([^"]+)"/;
const TITLE_RE =
  /<p class="title">([\s\S]*?)<\/p>/;
const DETAIL_LINK_RE =
  /<a href="\/channel\/(\d+)\/">/;
const YOUTUBE_ID_RE =
  /href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{20,})"/;
const NUMBER_RE =
  /(?<![A-Za-z0-9])\d{1,3}(?:,\d{3})+|\b\d{4,}\b/g;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseSubscriberCount(block: string): number | null {
  const text = stripTags(block);
  const values = [...text.matchAll(NUMBER_RE)]
    .map((match) => Number.parseInt(match[0].replace(/,/g, ''), 10))
    .filter((value) => Number.isFinite(value) && value >= 1_000);

  return values.length > 0 ? Math.max(...values) : null;
}

function parseListPage(html: string): ListEntry[] {
  const entries: ListEntry[] = [];
  for (const match of html.matchAll(LIST_ITEM_RE)) {
    const rankStr = match[1];
    const block = match[2];
    if (!rankStr || !block) continue;

    const detailMatch = block.match(DETAIL_LINK_RE);
    const titleMatch = block.match(TITLE_RE);
    const yuturaId = detailMatch?.[1];
    const titleHtml = titleMatch?.[1];
    if (!yuturaId || !titleHtml) continue;

    const thumbMatch = block.match(THUMB_RE);

    entries.push({
      rank: parseInt(rankStr, 10),
      yuturaId,
      name: stripTags(titleHtml),
      thumbnailUrl: thumbMatch?.[1] ?? null,
      subscriberCount: parseSubscriberCount(block),
    });
  }
  return entries;
}

function parseYoutubeChannelId(html: string): string | null {
  const match = html.match(YOUTUBE_ID_RE);
  return match?.[1] ?? null;
}

async function fetchListPage(page: number): Promise<ListEntry[]> {
  const url = `${BASE_URL}/ranking/?p=${page}`;
  const html = await fetchHtml(url);
  const entries = parseListPage(html);
  if (entries.length === 0) {
    throw new Error(`yutura_empty_page page=${page}`);
  }
  return entries;
}

async function fetchMonthlyListPage(page: number, month: string): Promise<ListEntry[]> {
  const url = `${BASE_URL}/ranking/?p=${page}&mode=subscriber&date=${month}`;
  const html = await fetchHtml(url);
  const entries = parseListPage(html);
  if (entries.length === 0) {
    throw new Error(`yutura_monthly_empty_page month=${month} page=${page}`);
  }
  return entries;
}

async function resolveYoutubeChannelId(yuturaId: string): Promise<string | null> {
  const url = `${BASE_URL}/channel/${yuturaId}/`;
  const html = await fetchHtml(url, `${BASE_URL}/ranking/`);
  return parseYoutubeChannelId(html);
}

function lookupCachedYoutubeId(yuturaId: string): string | null {
  const row = db
    .prepare('SELECT id FROM channels WHERE source_id = ?')
    .get(yuturaId) as { id: string } | undefined;
  return row?.id ?? null;
}

function monthSnapshotTimestamp(month: string): string {
  if (!/^\d{6}$/.test(month)) {
    throw new Error(`invalid_month month=${month}`);
  }
  const year = month.slice(0, 4);
  const mm = month.slice(4, 6);
  return `${year}-${mm}-01T00:00:00.000Z`;
}

export async function backfillYuturaMonthlySnapshots(month: string): Promise<void> {
  const startedAt = new Date().toISOString();
  const polledAt = monthSnapshotTimestamp(month);
  try {
    const listEntries: ListEntry[] = [];
    for (let page = 1; page <= PAGE_COUNT; page++) {
      const entries = await fetchMonthlyListPage(page, month);
      listEntries.push(...entries);
      console.log(
        `[worker] yutura_monthly_page=${page} month=${month} entries=${entries.length} total=${listEntries.length}`,
      );
      if (page < PAGE_COUNT) await sleep(env.YUTURA_REQUEST_DELAY_MS);
    }

    const seen = new Set<string>();
    const targets = listEntries
      .filter((entry) => {
        if (seen.has(entry.yuturaId)) return false;
        seen.add(entry.yuturaId);
        return entry.subscriberCount != null;
      })
      .slice(0, env.BACKGROUND_LIMIT);

    const insertSnapshot = db.prepare(`
      INSERT OR REPLACE INTO subscriber_snapshots
        (channel_id, polled_at, subscriber_count, video_count, view_count)
      VALUES (?, ?, ?, NULL, NULL)
    `);

    const write = db.transaction((rows: Array<{ id: string; count: number }>) => {
      for (const row of rows) {
        insertSnapshot.run(row.id, polledAt, row.count);
      }
    });

    const snapshots: Array<{ id: string; count: number }> = [];
    let cacheHits = 0;
    let detailFetches = 0;
    let detailFailures = 0;
    let missingCounts = 0;

    for (const entry of targets) {
      if (entry.subscriberCount == null) {
        missingCounts++;
        continue;
      }

      const cached = lookupCachedYoutubeId(entry.yuturaId);
      if (cached) {
        snapshots.push({ id: cached, count: entry.subscriberCount });
        cacheHits++;
        continue;
      }

      try {
        const ytId = await resolveYoutubeChannelId(entry.yuturaId);
        detailFetches++;
        if (ytId) {
          snapshots.push({ id: ytId, count: entry.subscriberCount });
        } else {
          detailFailures++;
          console.log(
            `[worker] yutura_monthly_no_youtube_id month=${month} yutura_id=${entry.yuturaId} name="${entry.name}"`,
          );
        }
      } catch (err) {
        detailFailures++;
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[worker] yutura_monthly_detail_error month=${month} yutura_id=${entry.yuturaId} reason=${message}`);
      }
      await sleep(env.YUTURA_REQUEST_DELAY_MS);
    }

    write(snapshots);

    const durationMs = Date.now() - new Date(startedAt).getTime();
    console.log(
      `[worker] yutura_monthly_backfill_success month=${month} polled_at=${polledAt} ` +
        `snapshots=${snapshots.length} cache_hits=${cacheHits} detail_fetches=${detailFetches} ` +
        `detail_failures=${detailFailures} missing_counts=${missingCounts} duration_ms=${durationMs}`,
    );
  } finally {
    await destroyFlaresolverrSession();
  }
}

export async function pollYutura(): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const listEntries: ListEntry[] = [];
    for (let page = 1; page <= PAGE_COUNT; page++) {
      const entries = await fetchListPage(page);
      listEntries.push(...entries);
      console.log(
        `[worker] yutura_list_page=${page} entries=${entries.length} total=${listEntries.length}`,
      );
      if (page < PAGE_COUNT) await sleep(env.YUTURA_REQUEST_DELAY_MS);
    }

    // Deduplicate by yuturaId (paranoia) and cap at BACKGROUND_LIMIT.
    const seen = new Set<string>();
    const deduped = listEntries.filter((e) => {
      if (seen.has(e.yuturaId)) return false;
      seen.add(e.yuturaId);
      return true;
    });
    const targets = deduped.slice(0, env.BACKGROUND_LIMIT);

    const resolved: ResolvedChannel[] = [];
    let cacheHits = 0;
    let detailFetches = 0;
    let detailFailures = 0;

    for (const entry of targets) {
      const cached = lookupCachedYoutubeId(entry.yuturaId);
      if (cached) {
        resolved.push({ ...entry, youtubeChannelId: cached });
        cacheHits++;
        continue;
      }
      try {
        const ytId = await resolveYoutubeChannelId(entry.yuturaId);
        detailFetches++;
        if (ytId) {
          resolved.push({ ...entry, youtubeChannelId: ytId });
        } else {
          detailFailures++;
          console.log(
            `[worker] yutura_no_youtube_id yutura_id=${entry.yuturaId} name="${entry.name}"`,
          );
        }
      } catch (err) {
        detailFailures++;
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[worker] yutura_detail_error yutura_id=${entry.yuturaId} reason=${message}`);
      }
      await sleep(env.YUTURA_REQUEST_DELAY_MS);
    }

    if (resolved.length === 0) {
      throw new Error('yutura_no_channels_resolved');
    }

    const now = new Date().toISOString();

    const upsert = db.prepare(`
      INSERT INTO channels (id, source_id, handle, name, thumbnail_url, is_active, first_seen_at, last_seen_at)
      VALUES (?, ?, NULL, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_id     = excluded.source_id,
        name          = excluded.name,
        thumbnail_url = COALESCE(excluded.thumbnail_url, channels.thumbnail_url),
        is_active     = 1,
        last_seen_at  = excluded.last_seen_at
    `);

    const upsertMany = db.transaction((chs: ResolvedChannel[]) => {
      for (const ch of chs) {
        upsert.run(
          ch.youtubeChannelId,
          ch.yuturaId,
          ch.name,
          ch.thumbnailUrl ?? null,
          now,
          now,
        );
      }
    });
    upsertMany(resolved);

    const activeIds = resolved.map((c) => c.youtubeChannelId);
    const placeholders = activeIds.map(() => '?').join(',');
    db.prepare(`UPDATE channels SET is_active = 0 WHERE id NOT IN (${placeholders})`).run(...activeIds);

    const durationMs = Date.now() - new Date(startedAt).getTime();
    console.log(
      `[worker] yutura_poll_success channels=${resolved.length} ` +
        `cache_hits=${cacheHits} detail_fetches=${detailFetches} detail_failures=${detailFailures} ` +
        `duration_ms=${durationMs}`,
    );
    db.prepare(
      'INSERT INTO yutura_pulls (pulled_at, status, channels_count) VALUES (?, ?, ?)',
    ).run(startedAt, 'success', resolved.length);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] yutura_poll_failed reason=${message}`);
    db.prepare(
      'INSERT INTO yutura_pulls (pulled_at, status, error) VALUES (?, ?, ?)',
    ).run(startedAt, 'failed', message);
  } finally {
    await destroyFlaresolverrSession();
  }
}
