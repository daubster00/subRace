// One-shot migration 007 application + verification for the local DB.
// Runs the SQL file in a transaction and prints before/after row counts so we
// can sanity-check the dedup result. Idempotent guard via _migrations table.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database('./data/subrace.db');

const before = {
  snapshots: db.prepare('SELECT COUNT(*) c FROM subscriber_snapshots').get().c,
  projected: db
    .prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='projected_subscriber_snapshots'`)
    .get().c > 0
    ? db.prepare('SELECT COUNT(*) c FROM projected_subscriber_snapshots').get().c
    : 'table does not exist',
};
console.log('=== BEFORE ===');
console.log(before);

const sql = fs.readFileSync(path.join('migrations', '007_milestone_history.sql'), 'utf-8');

const already = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get('007_milestone_history.sql');
if (already) {
  console.log('\n[skip] migration 007 already applied');
} else {
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
      '007_milestone_history.sql',
      new Date().toISOString(),
    );
  })();
  console.log('\n[apply] migration 007 applied');
}

const after = {
  snapshots: db.prepare('SELECT COUNT(*) c FROM subscriber_snapshots').get().c,
  by_source: db.prepare(`
    SELECT source, COUNT(*) AS n
    FROM subscriber_snapshots
    GROUP BY source
    ORDER BY n DESC
  `).all(),
  poll_state: db.prepare('SELECT COUNT(*) c FROM poll_state').get().c,
  display_state: db.prepare('SELECT COUNT(*) c FROM display_state').get().c,
  projected_table_exists: db
    .prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='projected_subscriber_snapshots'`)
    .get().c > 0,
  unique_index_exists: db
    .prepare(`SELECT count(*) c FROM sqlite_master WHERE type='index' AND name='idx_subscriber_snapshots_unique_milestone'`)
    .get().c > 0,
};
console.log('\n=== AFTER ===');
console.log(after);

// ISSEI sanity check
const issei = db.prepare(`
  SELECT polled_at, subscriber_count, source
  FROM subscriber_snapshots
  WHERE channel_id = 'UC6QZ_ss3i_8qLV_RczPZBkw'
  ORDER BY polled_at
`).all();
console.log(`\n=== ISSEI 마일스톤 ${issei.length}건 ===`);
issei.forEach(r => console.log(`${r.polled_at}  ${r.subscriber_count.toLocaleString()}  ${r.source}`));

// Unique index 동작 검증 — 같은 (channel_id, subscriber_count) 중복 INSERT 시도
try {
  db.prepare(`
    INSERT INTO subscriber_snapshots (channel_id, polled_at, subscriber_count, source)
    VALUES ('UC6QZ_ss3i_8qLV_RczPZBkw', '2099-01-01T00:00:00.000Z', 75500000, 'test')
  `).run();
  console.log('\n[FAIL] unique index가 중복을 막지 못함');
  // 청소
  db.prepare(`DELETE FROM subscriber_snapshots WHERE polled_at = '2099-01-01T00:00:00.000Z'`).run();
} catch (err) {
  console.log(`\n[OK] unique index 정상 작동: ${err.message}`);
}

db.close();
