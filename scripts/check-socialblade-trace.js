const Database = require('better-sqlite3');
const db = new Database('./data/subrace.db', { readonly: true });

// 1. subscriber_snapshots의 가장 오래된 polled_at — 60일치 SB가 들어왔다면 2026년 1월 말 정도가 보여야 함
const oldest = db.prepare(`
  SELECT MIN(polled_at) AS oldest, MAX(polled_at) AS newest, COUNT(*) AS n
  FROM subscriber_snapshots
`).get();
console.log('=== subscriber_snapshots 시간 범위 ===');
console.log(oldest);

// 2. 자정 UTC 행만 봤을 때 시간 범위
const midnightRange = db.prepare(`
  SELECT MIN(polled_at) AS oldest, MAX(polled_at) AS newest, COUNT(*) AS n
  FROM subscriber_snapshots
  WHERE polled_at LIKE '%T00:00:00.000Z'
`).get();
console.log('\n=== 자정 UTC 행 (yutura-chart 의심) ===');
console.log(midnightRange);

// 3. chart_pulls 로그 — yutura chart sweep과 monthly_backfill 이력
const pulls = db.prepare(`
  SELECT kind, pulled_at, status, channels_count, rows_inserted, error
  FROM chart_pulls
  ORDER BY pulled_at
`).all();
console.log('\n=== chart_pulls 전체 이력 ===');
pulls.forEach(p => console.log(p));

// 4. yutura_pulls (TOP200 sweep) 이력
const yuturaPulls = db.prepare(`
  SELECT MIN(pulled_at) AS oldest, MAX(pulled_at) AS newest, COUNT(*) AS n,
         SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS ok
  FROM yutura_pulls
`).get();
console.log('\n=== yutura_pulls 시간 범위 ===');
console.log(yuturaPulls);

// 5. youtube_polls 시간 범위
const youtubePolls = db.prepare(`
  SELECT MIN(polled_at) AS oldest, MAX(polled_at) AS newest, COUNT(*) AS n
  FROM youtube_polls
`).get();
console.log('\n=== youtube_polls 시간 범위 ===');
console.log(youtubePolls);

// 6. social_blade* 테이블이 정말 없는지 확인
const tables = db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
`).all();
console.log('\n=== 현재 존재하는 테이블 목록 ===');
console.log(tables.map(t => t.name));

// 7. 마이그레이션 이력
const migrations = db.prepare(`SELECT * FROM _migrations ORDER BY id`).all();
console.log('\n=== _migrations 이력 ===');
console.log(migrations);

// 8. ISSEI 채널의 polled_at 분포 — 월별로 행 수
const monthly = db.prepare(`
  SELECT substr(polled_at, 1, 7) AS month, COUNT(*) AS n,
    SUM(CASE WHEN polled_at LIKE '%T00:00:00.000Z' THEN 1 ELSE 0 END) AS midnight,
    SUM(CASE WHEN polled_at NOT LIKE '%T00:00:00.000Z' THEN 1 ELSE 0 END) AS other
  FROM subscriber_snapshots
  WHERE channel_id = 'UC6QZ_ss3i_8qLV_RczPZBkw'
  GROUP BY month
  ORDER BY month
`).all();
console.log('\n=== ISSEI 월별 행 수 ===');
monthly.forEach(m => console.log(m));
