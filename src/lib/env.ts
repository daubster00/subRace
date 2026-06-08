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
  // DEPRECATED (2026-06-06, BUG-01): 구 half-life 회귀 전용. 새 pace 알고리즘은
  // 날짜 무관·최근 N개 순서 기반이라 planner가 더 이상 참조하지 않는다 (날짜
  // window가 과거 마일스톤을 굶겨 fixed 오분류를 만든 원인). .env 호환 위해
  // schema에만 남김 (별도 정리 예정).
  MILESTONE_HISTORY_WINDOW_DAYS: z.coerce.number().int().min(1).default(120),
  MILESTONE_WEIGHT_HALF_LIFE_DAYS: z.coerce.number().min(0.1).default(30),
  // DEPRECATED (2026-06-06, BUG-02): 구 주기적 planner 주기. 채널별 독립
  // 타이머(channel-scheduler.ts)로 전환 후 더 이상 참조 안 함. schema에만 남김.
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
  SCHEDULE_MIN_MILESTONES: z.coerce.number().int().min(2).default(3),
  // 활동성 곡선 — 한 시간 사이클 안에 발생하는 이벤트 수 N을 absNet에 따라 동적
  // 산출 (2026-06-08, customer feedback). 51~100위 채널처럼 absNet이 작은 곳도
  // 시간당 N번은 움직이도록 강제. counterRatio도 N - 추세슬롯에서 자동 도출되어
  // absNet이 작을수록 감소 이벤트 비율이 커진다.
  //   N = round( N_MIN + (N_MAX - N_MIN) × (1 - sqrt(min(1, absNet / PIVOT))) )
  // 곡선 의미: absNet 0 → N_MAX, absNet ≥ PIVOT → N_MIN, 사이는 제곱근으로 감소
  // (=하위 구간이 가파르게 활동성 상승).
  SCHEDULE_ACTIVITY_N_MIN: z.coerce.number().int().min(1).default(40),
  SCHEDULE_ACTIVITY_N_MAX: z.coerce.number().int().min(1).default(100),
  SCHEDULE_ACTIVITY_PIVOT: z.coerce.number().int().min(1).default(300),
  // DEPRECATED (2026-06-08): SCHEDULE_ACTIVITY_* 곡선이 대체. planner는 더 이상
  // 참조하지 않으나 .env / runtime-settings 호환 위해 schema에 남김.
  SCHEDULE_MIN_EVENTS: z.coerce.number().int().min(1).default(6),
  // catch-up 전용 절대 상한. 사이클(1h)에 묶이지 않고 catchUpIntervalMs(3s) 고정
  // 간격으로 N=ceil(absNet/maxMag)개를 박는다 — 큰 갭은 자연히 1h 넘게 걸린다.
  // normal은 SCHEDULE_NORMAL_MAX_MAGNITUDE 사용.
  SCHEDULE_MAX_MAGNITUDE: z.coerce.number().int().min(1).default(40),
  // catch-up 이벤트 사이 고정 간격(ms). 클라 효과(트레이스/글로우/휠 ≈ 4.2s)가
  // 다음 이벤트 전에 완전히 끝나도록 4.2s + 0.8s 버퍼 = 5s가 기본
  // (2026-06-08 customer feedback). 사이클 길이와 무관하게 채널마다 갭 크기에
  // 따라 총 소요 시간이 달라진다.
  SCHEDULE_CATCHUP_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),
  // normal/target-bounce 사이클 이벤트당 절대 상한 (2026-06-08, customer feedback).
  // 큰 채널은 절대값이 커도 한 번에 큰 step으로 점프하면 간격이 멀어 정체로 보임 →
  // catch-up보다 작은 상한으로 잦은 소액 변화 유도. catch-up은 따로 큰 상한 유지.
  SCHEDULE_NORMAL_MAX_MAGNITUDE: z.coerce.number().int().min(1).default(10),
  SCHEDULE_COUNTER_RATIO: z.coerce.number().min(0).max(0.5).default(0.20),
  SCHEDULE_CYCLE_HOURS: z.coerce.number().min(0.1).default(1),
  SCHEDULE_TARGET_RATIO: z.coerce.number().min(0).max(2).default(0.95),
  SCHEDULE_BOUNCE_STEP_RATIO: z.coerce.number().min(0).max(1).default(0.01),
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
