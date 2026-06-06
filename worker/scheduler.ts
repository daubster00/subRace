import db from '@/lib/db';
import { env } from '@/lib/env';
import { createSingleFlight } from '@/lib/single-flight';
import { pollYutura } from './yutura';
import { pollYoutubeChannels } from './youtube-channels';
import { startLivePoller } from './youtube-live';
import { pollYoutubeLikes } from './youtube-likes';
import { startRetentionScheduler } from './retention';
import { planAllActiveChannels } from './display-planner';
import { executePendingChanges } from './display-executor';

function getLastSuccessAt(table: 'yutura_pulls' | 'youtube_polls'): Date | null {
  const col = table === 'yutura_pulls' ? 'pulled_at' : 'polled_at';
  const row = db
    .prepare(`SELECT MAX(${col}) AS t FROM ${table} WHERE status = 'success'`)
    .get() as { t: string | null };
  return row.t ? new Date(row.t) : null;
}

function getLastYoutubePacedAt(): Date | null {
  const row = db
    .prepare(`
      SELECT MAX(polled_at) AS t
      FROM youtube_polls
      WHERE status IN ('success', 'quota_exceeded')
    `)
    .get() as { t: string | null };
  return row.t ? new Date(row.t) : null;
}

function isDue(lastAt: Date | null, intervalMs: number): boolean {
  if (!lastAt) return true;
  return Date.now() - lastAt.getTime() >= intervalMs;
}

function hasChannelsWithoutSnapshots(): boolean {
  const { n: activeChannels } = db.prepare(
    'SELECT COUNT(*) as n FROM channels WHERE is_active = 1'
  ).get() as { n: number };
  if (activeChannels === 0) return false;
  const { n: snapshots } = db.prepare(
    'SELECT COUNT(*) as n FROM subscriber_snapshots'
  ).get() as { n: number };
  return snapshots === 0;
}

// Likes polling cadence is tracked in-memory because it doesn't log to a
// dedicated polls table; on worker restart we just fire once on startup and
// then resume the cadence. Losing this on restart is harmless — the worst case
// is one extra poll, which costs 1 unit when CLIENT_VIDEO_ID is set.
let lastLikesPollAt: Date | null = null;
// 같은 이유로 planner cadence도 in-memory. display_state 자체에 plan_date가
// 박혀 있어 재시작 직후 첫 tick이 doubles로 돌아도 shouldReplan이 대부분
// false라 비용 거의 없음.
let lastPlannerAt: Date | null = null;
// executor는 60s 고정 cadence — pickFirstIntervalMs의 MIN_INTERVAL_MS와 같은
// 단위. 더 자주 돌아봐야 next_change_at 정확도가 안 올라가고, 더 늦으면
// 변경이 누적돼 한 tick에 몰린다.
let lastExecutorAt: Date | null = null;
// Set by startScheduler so triggerLikesPoll can route reload-driven refreshes
// through the same single-flight as the cadence tick.
let runLikesFn: (() => Promise<void>) | null = null;

export function startScheduler(): void {
  // env values are read inside each tick so runtime-settings overrides
  // (set via the settings UI) take effect without restarting the worker.
  const yuturaIntervalMs = (): number => env.YUTURA_INTERVAL_HOURS * 60 * 60 * 1000;
  const channelsIntervalMs = (): number => env.YOUTUBE_POLL_INTERVAL_HOURS * 60 * 60 * 1000;
  const likesIntervalMs = (): number => env.YOUTUBE_LIKES_POLL_INTERVAL_HOURS * 60 * 60 * 1000;
  const plannerIntervalMs = (): number => env.DISPLAY_PLANNER_INTERVAL_MINUTES * 60 * 1000;
  const executorIntervalMs = 60_000;

  // isDue() only inspects the last *finished* poll, so without single-flight
  // locks a long-running poll (yutura resolve ~225s) would overlap with the
  // next 60s tick and fan out duplicate upstream requests.
  const runYutura = createSingleFlight(() => pollYutura());
  const runChannels = createSingleFlight(() => pollYoutubeChannels());
  const runLikes = createSingleFlight(async () => {
    try {
      await pollYoutubeLikes();
    } finally {
      // Update the in-memory cursor even on failure so a persistent error
      // (e.g. quota exhausted) doesn't busy-loop the API.
      lastLikesPollAt = new Date();
    }
  });
  runLikesFn = runLikes;

  // planner는 동기 DB 작업이라 빠르지만 single-flight로 setInterval 중첩만 차단.
  const runPlanner = createSingleFlight(async () => {
    try {
      const stats = planAllActiveChannels();
      if (stats.planned > 0 || stats.fixed > 0 || stats.noPollState > 0) {
        console.log(
          `[worker] display_planner_tick considered=${stats.considered} planned=${stats.planned} fixed=${stats.fixed} skipped=${stats.skipped} no_poll_state=${stats.noPollState}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[worker] display_planner_failed reason=${message}`);
    } finally {
      lastPlannerAt = new Date();
    }
  });

  // executor도 동기 DB 작업. due 0이면 로그 silent — 대부분 tick은 그렇다.
  const runExecutor = createSingleFlight(async () => {
    try {
      const stats = executePendingChanges();
      if (stats.executed > 0) {
        console.log(
          `[worker] display_executor_tick due=${stats.due} executed=${stats.executed} channels=${stats.channels} noop=${stats.noopDelta}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[worker] display_executor_failed reason=${message}`);
    } finally {
      lastExecutorAt = new Date();
    }
  });

  if (isDue(getLastSuccessAt('yutura_pulls'), yuturaIntervalMs())) void runYutura();

  const channelsDue = isDue(getLastYoutubePacedAt(), channelsIntervalMs()) || hasChannelsWithoutSnapshots();
  console.log(`[scheduler] channels_due=${channelsDue} channels_without_snapshots=${hasChannelsWithoutSnapshots()}`);
  if (channelsDue) void runChannels();

  // No persisted last-poll for likes — fire once on startup, then cadence.
  void runLikes();

  // planner는 startup에 한 번 — 워커가 죽어 있던 사이 누적된 plan_date 변경 /
  // API 변경을 따라잡는다. executor도 마찬가지: 다운타임 동안 next_change_at이
  // 지나간 채널은 첫 tick에서 모두 한 번씩 처리(이후 정상 cadence로 분산).
  void runPlanner();
  void runExecutor();

  setInterval(() => {
    if (isDue(getLastSuccessAt('yutura_pulls'), yuturaIntervalMs())) void runYutura();
  }, 60_000);

  setInterval(() => {
    if (isDue(getLastYoutubePacedAt(), channelsIntervalMs())) void runChannels();
  }, 60_000);

  setInterval(() => {
    if (isDue(lastLikesPollAt, likesIntervalMs())) void runLikes();
  }, 60_000);

  setInterval(() => {
    if (isDue(lastPlannerAt, plannerIntervalMs())) void runPlanner();
  }, 60_000);

  setInterval(() => {
    if (isDue(lastExecutorAt, executorIntervalMs)) void runExecutor();
  }, 60_000);

  startLivePoller();
  startRetentionScheduler();
}

// Exposed so the settings reload path can force a likes refresh immediately
// after CLIENT_CHANNEL_ID / CLIENT_VIDEO_ID changes. Routes through the same
// single-flight as the cadence tick so we never have two pollYoutubeLikes
// in flight at once.
export function triggerLikesPoll(): void {
  if (runLikesFn) void runLikesFn();
}
