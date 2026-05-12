import { NextResponse } from 'next/server';
import {
  CLEARABLE_OVERRIDABLE_KEYS,
  OVERRIDABLE_KEYS,
  writeOverrides,
  type OverridableKey,
} from '@/lib/runtime-settings';
import { env } from '@/lib/env';

const WORKER_INTERNAL_URL = process.env.WORKER_INTERNAL_URL ?? 'http://worker:3001';

async function notifyWorker(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    await fetch(`${WORKER_INTERNAL_URL}/internal/reload-settings`, {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[settings] worker_notify_failed reason="${message}"`);
  }
}

// Effective values for the editable subset of env. Reading through `env`
// returns the override (when present) or the .env-backed default.
function effectiveSettings(): Record<OverridableKey, string | number> {
  const out = {} as Record<OverridableKey, string | number>;
  const envRecord = env as unknown as Record<string, string | number | undefined>;
  for (const k of OVERRIDABLE_KEYS) {
    const v = envRecord[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function GET(): NextResponse {
  return NextResponse.json(effectiveSettings());
}

export async function PUT(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // Strip empty / null entries — they mean "leave unchanged" rather than "set to ''".
  // Exception: keys in CLEARABLE_OVERRIDABLE_KEYS (e.g. CLIENT_VIDEO_ID) accept
  // explicit '' as "clear this override" so the user can return to auto mode.
  const filtered: Record<string, unknown> = {};
  const incoming = body as Record<string, unknown>;
  for (const k of OVERRIDABLE_KEYS) {
    const v = incoming[k];
    if (v === undefined || v === null) continue;
    if (v === '' && !CLEARABLE_OVERRIDABLE_KEYS.has(k)) continue;
    filtered[k] = v;
  }

  try {
    writeOverrides(filtered);
    await notifyWorker();
    return NextResponse.json(effectiveSettings());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[error] settings_write_failed message="${message}"`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
