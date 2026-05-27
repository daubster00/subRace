// 현재 local DB의 실제 상태 검증. 새 세션에서 보고한 불일치(poll_state/
// display_state/unique index 없음, yutura_pulls/chart_pulls 없음, 1,347행)의
// 진위를 확인.

const Database = require('better-sqlite3');
const fs = require('fs');

function inspect(label, dbPath) {
  if (!fs.existsSync(dbPath)) {
    console.log(`\n=== ${label} ===\n[skip] not found: ${dbPath}`);
    return;
  }
  const stat = fs.statSync(dbPath);
  console.log(`\n=== ${label} (${dbPath}) ===`);
  console.log(`size: ${(stat.size / 1024 / 1024).toFixed(2)} MB, mtime: ${stat.mtime.toISOString()}`);

  const db = new Database(dbPath, { readonly: true });

  try {
    const migrations = db.prepare(`SELECT name, applied_at FROM _migrations ORDER BY name`).all();
    console.log('\n_migrations:');
    migrations.forEach(m => console.log(`  ${m.name}  ${m.applied_at}`));
  } catch (e) {
    console.log(`\n_migrations: [error] ${e.message}`);
  }

  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
  console.log('\ntables:', tables.map(t => t.name).join(', '));

  const indices = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
  console.log('\nindices:', indices.map(i => i.name).join(', '));

  // 핵심 체크 항목
  const checks = {};
  const tableNames = tables.map(t => t.name);
  checks['subscriber_snapshots.source 컬럼'] = (() => {
    try {
      const cols = db.prepare(`PRAGMA table_info(subscriber_snapshots)`).all();
      return cols.some(c => c.name === 'source') ? 'OK' : 'MISSING';
    } catch (e) { return `err: ${e.message}`; }
  })();
  checks['poll_state 테이블'] = tableNames.includes('poll_state') ? 'OK' : 'MISSING';
  checks['display_state 테이블'] = tableNames.includes('display_state') ? 'OK' : 'MISSING';
  checks['idx_subscriber_snapshots_unique_milestone'] = indices.some(i => i.name === 'idx_subscriber_snapshots_unique_milestone') ? 'OK' : 'MISSING';
  checks['yutura_pulls 테이블'] = tableNames.includes('yutura_pulls') ? 'OK' : 'MISSING';
  checks['chart_pulls 테이블'] = tableNames.includes('chart_pulls') ? 'OK' : 'MISSING';
  checks['projected_subscriber_snapshots (DROP 대상)'] = tableNames.includes('projected_subscriber_snapshots') ? 'STILL EXISTS' : 'DROPPED (OK)';

  if (tableNames.includes('subscriber_snapshots')) {
    const cnt = db.prepare(`SELECT COUNT(*) c FROM subscriber_snapshots`).get().c;
    checks['subscriber_snapshots 행 수'] = cnt;

    try {
      const bySource = db.prepare(`SELECT source, COUNT(*) AS n FROM subscriber_snapshots GROUP BY source ORDER BY n DESC`).all();
      checks['source 분포'] = JSON.stringify(bySource);
    } catch (e) { checks['source 분포'] = `err: ${e.message}`; }
  }

  console.log('\n핵심 체크:');
  Object.entries(checks).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  db.close();
}

inspect('현재 local DB', './data/subrace.db');
inspect('M1 적용 직전 백업', './data/subrace.db.pre-m1-backup');
