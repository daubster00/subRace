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
  // Per-channel chart polling (≈ N(active) HTTP requests per sweep). Used to
  // populate subscriber_snapshots with 30-day daily milestone data and is the
  // primary input for the Phase C trend_baseline calculation.
  YUTURA_CHART_INTERVAL_HOURS: z.coerce.number().min(1).default(24),
  // Monthly ranking backfill from ~60 days ago. Fills the snapshot rows that
  // the "stagnant channel" fallback in snapshot.ts depends on.
  YUTURA_MONTHLY_BACKFILL_INTERVAL_HOURS: z.coerce.number().min(1).default(720),
  // Fractional values allowed so we can dial polling down to minutes for testing.
  // Floor of 0.01h (~36s) keeps anyone from accidentally hammering the YouTube API.
  // YOUTUBE_POLL_INTERVAL_HOURS now controls ONLY the 150-channel ranking poll
  // (channels.list, 3 units/cycle). Likes polling has its own cadence so a
  // fast ranking refresh doesn't drag the more expensive likes endpoint along.
  YOUTUBE_POLL_INTERVAL_HOURS: z.coerce.number().min(0.01).default(6),
  // Likes polling cadence. With CLIENT_VIDEO_ID set this is just 1 unit/cycle
  // (videos.list), so a tight interval is cheap. Without it, the auto fallback
  // path can cost up to 101 units/cycle on a cache miss — keep this generous
  // unless you've pinned CLIENT_VIDEO_ID.
  YOUTUBE_LIKES_POLL_INTERVAL_HOURS: z.coerce.number().min(0.01).default(0.5),
  SURGE_WINDOW_HOURS: z.coerce.number().min(0.01).default(24),
  ESTIMATION_SAFETY_RATIO: z.coerce.number().min(0).max(1).default(0.85),
  // 마일스톤 회귀 계산 (src/lib/milestone-delta.ts).
  // - WINDOW: 회귀에 사용할 과거 기간. 너무 좁으면 표본 부족, 너무 넓으면
  //   채널의 옛 페이스가 추세에 끼어듦. 가중치가 지수 감쇠라 실질 무게는
  //   최근 30~60일에 쏠림.
  // - HALF_LIFE: 가중치 반감기. 30일 전 행은 어제 행의 1/2 무게,
  //   60일 전 행은 1/4, 90일 전 행은 1/8.
  MILESTONE_HISTORY_WINDOW_DAYS: z.coerce.number().int().min(1).default(120),
  MILESTONE_WEIGHT_HALF_LIFE_DAYS: z.coerce.number().min(0.1).default(30),
  // M4 display-planner.
  // - INTERVAL: scheduler가 planAllActiveChannels()를 호출하는 주기. 5분이면
  //   하루 288회 검사. 대부분 채널은 shouldReplan=false라 비용은 작음.
  // - JITTER_RATIO: 평균 간격 ±N 분산. 0.5면 [0.5×avg, 1.5×avg]. 0이면 균등.
  // - CHANGE_BIAS_*는 M5 executor가 증가/감소 이벤트 비율을 정할 때 사용.
  //   planner는 today_delta 부호로 추세만 정하고, 이벤트별 방향은 executor가
  //   bias 범위에서 랜덤 선택. (스펙 L282~290)
  DISPLAY_PLANNER_INTERVAL_MINUTES: z.coerce.number().min(1).default(5),
  // DEPRECATED (2026-06-06): 구 M5 랜덤 executor 전용. 사전 스케줄 전환 후
  // 어떤 코드도 참조하지 않음. .env 호환 위해 schema에만 남김 (별도 정리 예정).
  CHANGE_BIAS_UP_INCREASE_MIN: z.coerce.number().min(0).max(1).default(0.75),
  CHANGE_BIAS_UP_INCREASE_MAX: z.coerce.number().min(0).max(1).default(0.90),
  CHANGE_BIAS_DOWN_DECREASE_MIN: z.coerce.number().min(0).max(1).default(0.60),
  CHANGE_BIAS_DOWN_DECREASE_MAX: z.coerce.number().min(0).max(1).default(0.85),
  CHANGE_INTERVAL_JITTER_RATIO: z.coerce.number().min(0).max(0.99).default(0.50),
  // 사전 스케줄 아키텍처 (2026-06-06, customer-feedback-2).
  // - MIN_MILESTONES: 이보다 적은 마일스톤 채널은 phase='fixed' (api값 고정 표시).
  // - MIN_EVENTS: 1시간 사이클 최소 이벤트 수 (느린 채널도 안 멈추게).
  // - MAX_MAGNITUDE: 이벤트당 절대 상한 (한 번에 ±20 초과 금지, 항목 4).
  // - COUNTER_RATIO: 반대 방향 이벤트 비율 (정상 0.20, catch-up은 코드에서 0).
  // - CYCLE_HOURS: 채널별 롤링 사이클 길이.
  // - TARGET_RATIO: target = 마일스톤 + ratio×(새−직전) (항목 12, 0.85→0.95).
  // - BOUNCE_STEP_RATIO: target 도달 후 진동 폭 = ratio × bucket unit (±3%).
  // - PACE_MAX_INTERVALS: 예상 도달 시간 산출에 쓸 최근 인접 간격 최대 수.
  // - EVENT_JITTER_RATIO: 이벤트 시각 분산 비율.
  SCHEDULE_MIN_MILESTONES: z.coerce.number().int().min(2).default(6),
  SCHEDULE_MIN_EVENTS: z.coerce.number().int().min(1).default(6),
  SCHEDULE_MAX_MAGNITUDE: z.coerce.number().int().min(1).default(20),
  SCHEDULE_COUNTER_RATIO: z.coerce.number().min(0).max(0.5).default(0.20),
  SCHEDULE_CYCLE_HOURS: z.coerce.number().min(0.1).default(1),
  SCHEDULE_TARGET_RATIO: z.coerce.number().min(0).max(2).default(0.95),
  SCHEDULE_BOUNCE_STEP_RATIO: z.coerce.number().min(0).max(1).default(0.03),
  SCHEDULE_PACE_MAX_INTERVALS: z.coerce.number().int().min(1).default(8),
  SCHEDULE_EVENT_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.5),
  RANK_ALERT_ABSOLUTE_THRESHOLD: z.coerce.number().int().min(0).default(3000),
  RANK_ALERT_TIME_THRESHOLD_HOURS: z.coerce.number().min(0).default(0.25),
  LIVE_VIEWER_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(60),
  TIMEZONE: z.string().default("Asia/Tokyo"),
  REGION: z.string().default("JP"),

  // 비밀/필수 키 (기본값 없음 — 누락 시 부팅 실패)
  CLIENT_CHANNEL_ID: z.string().min(1, "CLIENT_CHANNEL_ID is required"),
  BASIC_AUTH_USERNAME: z.string().min(1, "BASIC_AUTH_USERNAME is required"),
  BASIC_AUTH_PASSWORD: z.string().min(1, "BASIC_AUTH_PASSWORD is required"),
  YOUTUBE_API_KEY: z.string().min(1, "YOUTUBE_API_KEY is required"),

  // Optional manual override. When set, detectLive / pollYoutubeLikes use this
  // video id directly instead of issuing search.list (100 units/call) to find
  // the channel's current live stream or latest video. Empty string = use
  // auto-detect path.
  CLIENT_VIDEO_ID: z.string().default(""),
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
