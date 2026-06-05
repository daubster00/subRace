// One-shot migration 009 application + verification for the local DB.
// 같은 (channel_id, subscriber_count)도 polled_at만 다르면 들어가는지 확인한다.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database('./data/subrace.db');

const before = {
  snapshots: db.prepare('SELECT COUNT(*) c FROM subscriber_snapshots').get().c,
  unique_index_exists: db
    .prepare(`SELECT count(*) c FROM sqlite_master WHERE type='index' AND name='idx_subscriber_snapshots_unique_milestone'`)
    .get().c > 0,
};
console.log('=== BEFORE ===');
console.log(before);

const sql = fs.readFileSync(path.join('migrations', '009_drop_milestone_uniqueness.sql'), 'utf-8');

const already = db.prepare(`SELECT 1 FROM _migrations WHERE name = ?`).get('009_drop_milestone_uniqueness.sql');
if (already) {
  console.log('\n[skip] migration 009 already applied');
} else {
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
      '009_drop_milestone_uniqueness.sql',
      new Date().toISOString(),
    );
  })();
  console.log('\n[apply] migration 009 applied');
}

const after = {
  snapshots: db.prepare('SELECT COUNT(*) c FROM subscriber_snapshots').get().c,
  unique_index_exists: db
    .prepare(`SELECT count(*) c FROM sqlite_master WHERE type='index' AND name='idx_subscriber_snapshots_unique_milestone'`)
    .get().c > 0,
};
console.log('\n=== AFTER ===');
console.log(after);

// 재진입 INSERT 검증: 임의 채널을 골라 직전 값 그대로 다른 polled_at에 INSERT.
const sampleRow = db.prepare(`
  SELECT channel_id, subscriber_count
  FROM subscriber_snapshots
  ORDER BY polled_at DESC
  LIMIT 1
`).get();

if (!sampleRow) {
  console.log('\n[skip verify] subscriber_snapshots 비어있음');
} else {
  const testPolledAt = '2099-01-01T00:00:00.000Z';
  try {
    db.prepare(`
      INSERT INTO subscriber_snapshots (channel_id, polled_at, subscriber_count, source)
      VALUES (?, ?, ?, 'test_009')
    `).run(sampleRow.channel_id, testPolledAt, sampleRow.subscriber_count);
    console.log(`\n[OK] 같은 (channel_id=${sampleRow.channel_id}, count=${sampleRow.subscriber_count}) 재진입 INSERT 성공`);
    db.prepare(`DELETE FROM subscriber_snapshots WHERE polled_at = ? AND source = 'test_009'`).run(testPolledAt);
    console.log('[OK] 검증 행 정리 완료');
  } catch (err) {
    console.log(`\n[FAIL] 재진입 INSERT 실패: ${err.message}`);
  }

  // PK 가드는 살아있는지 검증: 동일 (channel_id, polled_at)으로 두 번 INSERT는 막혀야 함.
  const existingRow = db.prepare(`SELECT channel_id, polled_at FROM subscriber_snapshots LIMIT 1`).get();
  try {
    db.prepare(`
      INSERT INTO subscriber_snapshots (channel_id, polled_at, subscriber_count, source)
      VALUES (?, ?, 0, 'test_009_pk')
    `).run(existingRow.channel_id, existingRow.polled_at);
    console.log('[FAIL] PK 가드가 동일 polled_at 중복을 막지 못함');
    db.prepare(`DELETE FROM subscriber_snapshots WHERE source = 'test_009_pk'`).run();
  } catch (err) {
    console.log(`[OK] PK 가드 정상 작동: ${err.message}`);
  }
}

db.close();
