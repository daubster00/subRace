import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// Validation rules for keys that can be tweaked at runtime via the UI.
// Defaults are NOT applied here — the override file may be partial, and any
// key not present should fall through to env.ts (which has the .env defaults).
export const overridableShape = {
  DISPLAY_LIMIT:                     z.coerce.number().int().refine((v) => v === 50 || v === 100, 'must be 50 or 100'),
  BACKGROUND_LIMIT:                  z.coerce.number().int().min(1),
  YUTURA_INTERVAL_HOURS:             z.coerce.number().int().min(1),
  YUTURA_REQUEST_DELAY_MS:           z.coerce.number().int().min(0),
  YOUTUBE_POLL_INTERVAL_HOURS:       z.coerce.number().min(0.01),
  SURGE_WINDOW_HOURS:                z.coerce.number().min(0.01),
  ESTIMATION_SAFETY_RATIO:           z.coerce.number().min(0).max(1),
  RANK_ALERT_ABSOLUTE_THRESHOLD:     z.coerce.number().int().min(0),
  RANK_ALERT_TIME_THRESHOLD_HOURS:   z.coerce.number().min(0),
  LIVE_VIEWER_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1),
  TIMEZONE:                          z.string().min(1),
  REGION:                            z.string().min(1),
  CLIENT_CHANNEL_ID:                 z.string().min(1),
} as const;

const partialSchema = z.object(overridableShape).partial();

export type OverridableValues = z.infer<typeof partialSchema>;
export type OverridableKey = keyof typeof overridableShape;

export const OVERRIDABLE_KEYS = Object.keys(overridableShape) as OverridableKey[];

const SETTINGS_PATH = path.join(process.cwd(), 'data', 'runtime-settings.json');

let cache: OverridableValues = {};
let watcherStarted = false;

function readFromDisk(): OverridableValues {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const json = JSON.parse(raw) as unknown;
    const parsed = partialSchema.safeParse(json);
    if (!parsed.success) {
      console.warn('[runtime-settings] invalid_overrides — using base env values');
      return {};
    }
    return parsed.data;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      console.warn(`[runtime-settings] read_failed reason=${e.message ?? String(err)}`);
    }
    return {};
  }
}

function startWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    // Watch the parent directory rather than the file itself so the watcher
    // survives editors that rename-on-save and tools that recreate the file.
    const w = fs.watch(path.dirname(SETTINGS_PATH), { persistent: false }, (_event, fileName) => {
      if (fileName === path.basename(SETTINGS_PATH)) {
        cache = readFromDisk();
      }
    });
    w.on('error', (err) => {
      console.warn(`[runtime-settings] watch_error reason=${err.message}`);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[runtime-settings] watch_failed reason=${message}`);
  }
}

cache = readFromDisk();
startWatcher();

export function getOverride<K extends OverridableKey>(key: K): OverridableValues[K] {
  return cache[key];
}

export function getOverrides(): OverridableValues {
  return cache;
}

export function writeOverrides(updates: unknown): OverridableValues {
  if (!updates || typeof updates !== 'object') {
    throw new Error('invalid_payload');
  }
  const parsed = partialSchema.parse(updates);
  const next = { ...cache, ...parsed };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}
