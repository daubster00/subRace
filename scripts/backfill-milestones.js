// One-shot backfill: subscriber_snapshots → milestones.
//
// 입력 규칙 (사용자 결정 2026-06-10):
//   1. SocialBlade(socialblade_milestone) row를 시간순 우선 INSERT.
//   2. YouTube API(youtube_api_change) row는 시간순으로 보고
//        - 같은 날짜(YYYY-MM-DD)에 이미 milestones row가 있으면 SKIP
//        - 직전 milestones row(어떤 source든)의 subscriber_count와 같으면 SKIP
//      이외의 row만 INSERT.
//   3. socialblade_milestone 중에서도 직전 row와 값이 같으면 SKIP — SB 자체에도
//      같은 1만 단위 라운딩이 연속 찍힌 케이스(예: 4-25/4-26 5,590k)가 있어
//      0 transition을 만들어 추세 가중치를 깎는다. dedup 일관성 위해 같이 적용.
//
// 멱등: 이미 milestones에 row가 있으면 INSERT OR IGNORE로 충돌 무시.
// 컨테이너 내부에서 실행: docker exec subrace-worker node scripts/backfill-milestones.js
//
// 사용 시 컨테이너 정지 필요 없음(독립 트랜잭션). 단 worker가 milestones에
// 동시 INSERT 시도하면 busy 가능 → 보통은 정지 후 실행 권장.

const Database = require('better-sqlite3');
const path = process.env.SUBRACE_DB_PATH || '/app/data/subrace.db';
const db = new Database(path);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 10000');

// 채널별로 시간순 row를 받아 dedup 규칙대로 INSERT.
const channels = db.prepare(`SELECT id FROM channels`).all();

const selectSnapshots = db.prepare(`
  SELECT polled_at, subscriber_count, video_count, view_count, source
  FROM   subscriber_snapshots
  WHERE  channel_id = ?
  ORDER  BY polled_at ASC, CASE source
           WHEN 'socialblade_milestone' THEN 0
           WHEN 'youtube_api_change'    THEN 1
           ELSE 2
         END
`);

const insertMs = db.prepare(`
  INSERT OR IGNORE INTO milestones
    (channel_id, recorded_at, subscriber_count, video_count, view_count, source)
  VALUES (?, ?, ?, ?, ?, ?)
`);

let totalRead = 0;
let totalInserted = 0;
let skippedSameDate = 0;
let skippedSameValue = 0;

const run = db.transaction(() => {
  for (const { id } of channels) {
    const rows = selectSnapshots.all(id);
    let lastValue = null;          // 직전에 INSERT된 milestones row의 값
    const insertedDates = new Set(); // 이번 채널에서 INSERT된 YYYY-MM-DD 집합

    for (const r of rows) {
      totalRead++;
      const date = r.polled_at.slice(0, 10); // YYYY-MM-DD

      // 유튜브 row: 같은 날짜에 이미 INSERT된 row(=SB가 같은 날짜에 먼저 들어옴)
      // 있으면 SKIP.
      if (r.source === 'youtube_api_change' && insertedDates.has(date)) {
        skippedSameDate++;
        continue;
      }

      // 직전 row(어떤 source든)와 값 같으면 SKIP.
      if (lastValue !== null && r.subscriber_count === lastValue) {
        skippedSameValue++;
        continue;
      }

      const res = insertMs.run(
        id, r.polled_at, r.subscriber_count, r.video_count, r.view_count, r.source,
      );
      if (res.changes > 0) {
        totalInserted++;
        lastValue = r.subscriber_count;
        insertedDates.add(date);
      }
    }
  }
});

run();

const totalMs = db.prepare(`SELECT COUNT(*) AS n FROM milestones`).get().n;
const perChannel = db.prepare(`
  SELECT channel_id, COUNT(*) AS n FROM milestones GROUP BY channel_id
  ORDER BY n DESC LIMIT 5
`).all();

process.stdout.write(JSON.stringify({
  channels: channels.length,
  rows_scanned: totalRead,
  rows_inserted: totalInserted,
  skipped_same_date: skippedSameDate,
  skipped_same_value: skippedSameValue,
  total_milestones_after: totalMs,
  top_channels_by_ms_count: perChannel,
}, null, 2));

db.close();
