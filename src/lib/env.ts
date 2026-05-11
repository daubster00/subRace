import { z } from "zod";
import {
  OVERRIDABLE_KEYS,
  getOverride,
  type OverridableKey,
} from "./runtime-settings";

const envSchema = z.object({
  // 표시 설정 (기본값 있음)
  DISPLAY_LIMIT: z.coerce.number().int().refine((v) => v === 50 || v === 100).default(50),
  BACKGROUND_LIMIT: z.coerce.number().int().min(1).default(150),
  YUTURA_INTERVAL_HOURS: z.coerce.number().int().min(1).default(48),
  YUTURA_REQUEST_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  // Fractional values allowed so we can dial polling down to minutes for testing.
  // Floor of 0.01h (~36s) keeps anyone from accidentally hammering the YouTube API.
  YOUTUBE_POLL_INTERVAL_HOURS: z.coerce.number().min(0.01).default(6),
  SURGE_WINDOW_HOURS: z.coerce.number().min(0.01).default(24),
  ESTIMATION_SAFETY_RATIO: z.coerce.number().min(0).max(1).default(0.85),
  RANK_ALERT_ABSOLUTE_THRESHOLD: z.coerce.number().int().min(0).default(10000),
  RANK_ALERT_TIME_THRESHOLD_HOURS: z.coerce.number().min(0).default(1),
  LIVE_VIEWER_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(60),
  TIMEZONE: z.string().default("Asia/Tokyo"),
  REGION: z.string().default("JP"),

  // 비밀/필수 키 (기본값 없음 — 누락 시 부팅 실패)
  CLIENT_CHANNEL_ID: z.string().min(1, "CLIENT_CHANNEL_ID is required"),
  BASIC_AUTH_USERNAME: z.string().min(1, "BASIC_AUTH_USERNAME is required"),
  BASIC_AUTH_PASSWORD: z.string().min(1, "BASIC_AUTH_PASSWORD is required"),
  YOUTUBE_API_KEY: z.string().min(1, "YOUTUBE_API_KEY is required"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("[error] env_validation_failed");
  for (const issue of parsed.error.issues) {
    console.error(`[error] env_invalid key=${issue.path.join(".")} message="${issue.message}"`);
  }
  process.exit(1);
}

const baseValues = parsed.data;
export type Env = typeof baseValues;

// Runtime-tweakable keys are read through a Proxy so values written via the
// settings UI take effect on the next access — no restart of the Next.js
// server or the worker process required. fs.watch in runtime-settings.ts
// keeps the in-memory override cache up to date across both processes.
const overridableSet = new Set<string>(OVERRIDABLE_KEYS as readonly string[]);

export const env = new Proxy(baseValues, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && overridableSet.has(prop)) {
      const override = getOverride(prop as OverridableKey);
      if (override !== undefined) return override;
    }
    return Reflect.get(target, prop, receiver);
  },
}) as Env;
