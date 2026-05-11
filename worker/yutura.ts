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
}

interface ResolvedChannel extends ListEntry {
  youtubeChannelId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// yutura is behind Cloudflare, which blocks Node's fetch on TLS fingerprint
// (JA3/JA4) even with browser-matching headers. We shell out to curl, whose
// TLS handshake passes the WAF on Windows/macOS host curl. Inside a Linux
// container the stock OpenSSL-backed curl is also blocked, so the Docker
// image installs curl-impersonate and sets YUTURA_CURL_BIN=curl_chrome131.
const CURL_BIN = process.env.YUTURA_CURL_BIN ?? 'curl';

async function fetchHtml(url: string, referer?: string): Promise<string> {
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
  }
}
