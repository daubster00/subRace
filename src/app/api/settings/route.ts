import { NextResponse } from 'next/server';
import {
  OVERRIDABLE_KEYS,
  writeOverrides,
  type OverridableKey,
} from '@/lib/runtime-settings';
import { env } from '@/lib/env';

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
  const filtered: Record<string, unknown> = {};
  const incoming = body as Record<string, unknown>;
  for (const k of OVERRIDABLE_KEYS) {
    const v = incoming[k];
    if (v === undefined || v === null || v === '') continue;
    filtered[k] = v;
  }

  try {
    writeOverrides(filtered);
    return NextResponse.json(effectiveSettings());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[error] settings_write_failed message="${message}"`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
