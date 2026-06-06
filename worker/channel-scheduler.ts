import db from '@/lib/db';
import { env } from '@/lib/env';
import { planOneChannel } from './display-planner';

// BUG-03: 이벤트 적용 후 web의 SSE 허브로 push (worker→web). web은 운영자
// Basic Auth 뒤에 있어 worker가 자격증명으로 호출한다. settings 라우트의
// web→worker(WORKER_INTERNAL_URL) 패턴을 대칭으로 미러링.
const WEB_INTERNAL_URL = process.env.WEB_INTERNAL_URL ?? 'http://web:3000';
const PUSH_AUTH_HEADER =
  'Basic ' + Buffer.from(`${env.BASIC_AUTH_USERNAME}:${env.BASIC_AUTH_PASSWORD}`).toString('base64');

interface ChannelUpdate {
  channelId: string;
  subscriberCount: number;
  direction: 'up' | 'down' | null;
  changedAt: string;
}

// fire-and-forget. web이 일시 불가여도 클라는 다음 주기 snapshot으로 재동기화.
function pushUpdate(update: ChannelUpdate): void {
  void fetch(`${WEB_INTERNAL_URL}/api/internal/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: PUSH_AUTH_HEADER },
    body: JSON.stringify({ updates: [update] }),
  }).catch(() => {
    // web down/재시작 중 — 무시.
  });
}

// 채널별 독립 setTimeout 스케줄러 (BUG-02).
//
// 구 구조: 60초 executor 일괄 처리 + 5분 주기 planner → 사전 스케줄의 sub-60초
//          정밀도가 배칭에 뭉개지고 API 변경 감지가 최대 5분 지연.
// 새 구조: 채널마다 타이머 1개. "다음 이벤트 OR 사이클 만료" 중 빠른 시각을
//          가리킨다. 발화 시 도래 이벤트 적용 → 다음 시각으로 재무장. 채널 간
//          상호 의존 없음.
//
// 두 트리거:
//   1) 사이클 만료: 이벤트 소진 또는 next_cycle_reset_at 도달 → 해당 채널 재계획.
//   2) 새 마일스톤: youtube-channels가 새 구독자 수 기록 시 onNewMilestone 호출
//      → 즉시 재계획(catch-up). planOneChannel이 미적용 이벤트 DELETE → 이중 실행 방지.
//
// Node 단일 스레드 + better-sqlite3 동기 호출이라 타이머 콜백은 인터리브되지
// 않는다. clearTimeout → 재계획 → 재무장이 한 콜백 안에서 원자적으로 처리된다.

const timers = new Map<string, ReturnType<typeof setTimeout>>();

const SELECT_ACTIVE = `
  SELECT ps.channel_id
  FROM   poll_state ps
  JOIN   channels c ON c.id = ps.channel_id
  WHERE  c.is_active = 1
`;
const SELECT_NEXT_EVENT_AT = `
  SELECT MIN(scheduled_at) AS t FROM display_event_schedule
  WHERE channel_id = ? AND applied = 0
`;
const SELECT_RESET_AT = `
  SELECT next_cycle_reset_at AS t FROM display_state WHERE channel_id = ?
`;
const COUNT_UNAPPLIED = `
  SELECT COUNT(*) AS n FROM display_event_schedule WHERE channel_id = ? AND applied = 0
`;
const SELECT_DUE = `
  SELECT e.id, e.magnitude, d.display_subscriber_count AS disp, d.cap_subscriber_count AS cap
  FROM   display_event_schedule e
  JOIN   display_state d ON d.channel_id = e.channel_id
  WHERE  e.channel_id = ? AND e.applied = 0 AND e.scheduled_at <= ?
  ORDER  BY e.scheduled_at, e.id
`;
const MARK_APPLIED = `
  UPDATE display_event_schedule SET applied = 1, applied_at = ? WHERE id = ?
`;
const UPDATE_DISPLAY = `
  UPDATE display_state
     SET display_subscriber_count = ?,
         last_changed_at          = ?,
         last_change_direction    = COALESCE(?, last_change_direction),
         applied_change_count     = applied_change_count + 1,
         updated_at               = ?
   WHERE channel_id = ?
`;

const selActive       = db.prepare(SELECT_ACTIVE);
const selNextEventAt  = db.prepare(SELECT_NEXT_EVENT_AT);
const selResetAt      = db.prepare(SELECT_RESET_AT);
const countUnapplied  = db.prepare(COUNT_UNAPPLIED);
const selDue          = db.prepare(SELECT_DUE);
const markApplied     = db.prepare(MARK_APPLIED);
const updateDisplay   = db.prepare(UPDATE_DISPLAY);

interface DueRow { id: number; magnitude: number; disp: number; cap: number }

function clearChannelTimer(channelId: string): void {
  const t = timers.get(channelId);
  if (t) {
    clearTimeout(t);
    timers.delete(channelId);
  }
}

// "다음 이벤트 OR 사이클 만료" 중 빠른 시각으로 타이머 무장.
function armTimer(channelId: string): void {
  clearChannelTimer(channelId);

  const nextEvent = (selNextEventAt.get(channelId) as { t: string | null }).t;
  const reset = (selResetAt.get(channelId) as { t: string | null } | undefined)?.t ?? null;

  const candidates = [nextEvent, reset]
    .filter((x): x is string => !!x)
    .map((s) => new Date(s).getTime());
  if (candidates.length === 0) return; // 스케줄 없음(미플랜) — 무장 안 함

  const nextAt = Math.min(...candidates);
  const delay = Math.max(0, nextAt - Date.now());
  timers.set(channelId, setTimeout(() => fire(channelId), delay));
}

// 도래 이벤트 적용 후 다음 행동 결정.
function fire(channelId: string): void {
  try {
    const now = new Date();
    const nowIso = now.toISOString();

    const due = selDue.all(channelId, nowIso) as DueRow[];
    let finalDisplay: number | null = null;
    let lastDirection: 'up' | 'down' | null = null;
    if (due.length > 0) {
      db.transaction(() => {
        let running = due[0]!.disp; // JOIN상 모든 행 동일 → 첫 행 기준 누적
        for (const ev of due) {
          let next = running + ev.magnitude;
          if (next > ev.cap) next = ev.cap; // 안전망(정상 경로엔 미작동)
          if (next < 1) next = 1;
          const direction = ev.magnitude > 0 ? 'up' : ev.magnitude < 0 ? 'down' : null;
          markApplied.run(nowIso, ev.id);
          updateDisplay.run(next, nowIso, direction, nowIso, channelId);
          running = next;
          if (direction) lastDirection = direction;
        }
        finalDisplay = running;
      })();
    }

    // 표시값이 움직였으면 web SSE로 push (실시간 클라 반영).
    if (finalDisplay !== null) {
      pushUpdate({ channelId, subscriberCount: finalDisplay, direction: lastDirection, changedAt: nowIso });
    }

    // 사이클 만료(reset 도달) 또는 이벤트 소진 → 재계획. 아니면 다음 시각 재무장.
    const reset = (selResetAt.get(channelId) as { t: string | null } | undefined)?.t ?? null;
    const remaining = (countUnapplied.get(channelId) as { n: number }).n;
    const cycleDone = remaining === 0 || (reset != null && now.getTime() >= new Date(reset).getTime());

    if (cycleDone) {
      replanAndArm(channelId);
    } else {
      armTimer(channelId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] channel_fire_failed channel=${channelId} reason=${message}`);
    // 루프가 끊기지 않게 5초 후 재시도.
    clearChannelTimer(channelId);
    timers.set(channelId, setTimeout(() => fire(channelId), 5_000));
  }
}

// 재계획(미적용 이벤트 DELETE + 새 스케줄 생성) 후 재무장.
function replanAndArm(channelId: string): void {
  clearChannelTimer(channelId);
  try {
    planOneChannel(channelId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[worker] channel_replan_failed channel=${channelId} reason=${message}`);
  }
  armTimer(channelId);
}

// 새 마일스톤(YouTube API 변경) 트리거 — youtube-channels.ts가 호출.
// planOneChannel이 미적용 이벤트를 비우고 catch-up 플랜을 새로 깐다.
export function onNewMilestone(channelId: string): void {
  replanAndArm(channelId);
}

// 워커 시작 시: 기존 스케줄이 있으면(재시작 복구) 재무장, 없으면 새로 계획.
//   - display_state.next_cycle_reset_at 있음 → DB의 미적용 이벤트/리셋 시각으로
//     타이머 복구 (지난 scheduled_at은 delay 0으로 즉시 발화).
//   - 없음(첫 진입) → planOneChannel로 새 스케줄 생성.
export function startChannelSchedulers(): void {
  const channels = selActive.all() as { channel_id: string }[];
  let resumed = 0;
  let planned = 0;
  for (const { channel_id: channelId } of channels) {
    const ds = selResetAt.get(channelId) as { t: string | null } | undefined;
    if (ds && ds.t) {
      armTimer(channelId);
      resumed++;
    } else {
      replanAndArm(channelId);
      planned++;
    }
  }
  console.log(
    `[worker] channel_schedulers_started total=${channels.length} resumed=${resumed} planned=${planned}`,
  );
}

// 테스트/종료용 — 모든 타이머 해제.
export function stopChannelSchedulers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
