// Yutura fetch helpers shared by the ranking poller (yutura.ts) and the
// per-channel chart poller (yutura-chart.ts). Cloudflare-bypass strategy
// (FlareSolverr session vs curl-impersonate) lives here so both jobs share
// one session cache.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const BASE_URL = 'https://yutura.net';
const FETCH_TIMEOUT_SECONDS = 30;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

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

export async function destroyFlaresolverrSession(): Promise<void> {
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

export async function fetchHtml(url: string, referer?: string): Promise<string> {
  if (FLARESOLVERR_URL) return fetchViaFlaresolverr(url);
  return fetchViaCurl(url, referer);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
