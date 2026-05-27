// socialblade_milestone source 행이 정확히 어떤 데이터인지 검증.

const Database = require('better-sqlite3');
const db = new Database('./data/subrace.db', { readonly: true });

// 1. 시간 범위 + 채널 수
const range = db.prepare(`
  SELECT
    MIN(polled_at) AS oldest,
    MAX(polled_at) AS newest,
    COUNT(*) AS rows,
    COUNT(DISTINCT channel_id) AS channels,
    COUNT(DISTINCT DATE(polled_at)) AS distinct_dates
  FROM subscriber_snapshots
  WHERE source = 'socialblade_milestone'
`).get();
console.log('=== socialblade_milestone 전체 ===');
console.log(range);

// 2. 채널당 행 수 분포
const perChannel = db.prepare(`
  WITH per_channel AS (
    SELECT channel_id, COUNT(*) AS n
    FROM subscriber_snapshots
    WHERE source = 'socialblade_milestone'
    GROUP BY channel_id
  )
  SELECT
    COUNT(*) AS channels,
    MIN(n) AS min_rows, MAX(n) AS max_rows, ROUND(AVG(n), 1) AS avg_rows
  FROM per_channel
`).get();
console.log('\n=== 채널당 socialblade 행 수 분포 ===');
console.log(perChannel);

// 3. 채널 5개 샘플 — 어떤 채널이 가장 많고 적은지
const top5 = db.prepare(`
  SELECT c.name, s.channel_id, COUNT(*) AS milestones,
    MIN(s.subscriber_count) AS min_subs, MAX(s.subscriber_count) AS max_subs,
    MIN(s.polled_at) AS first_date, MAX(s.polled_at) AS last_date
  FROM subscriber_snapshots s
  LEFT JOIN channels c ON c.id = s.channel_id
  WHERE s.source = 'socialblade_milestone'
  GROUP BY s.channel_id
  ORDER BY COUNT(*) DESC
  LIMIT 5
`).all();
console.log('\n=== 마일스톤 가장 많은 채널 5개 ===');
top5.forEach(r => console.log(
  `${(r.name || '(unknown)').padEnd(30)} ${r.milestones}건  ${r.min_subs.toLocaleString()} → ${r.max_subs.toLocaleString()}  (${r.first_date.slice(0,10)} ~ ${r.last_date.slice(0,10)})`
));

const bottom5 = db.prepare(`
  SELECT c.name, s.channel_id, COUNT(*) AS milestones,
    MIN(s.subscriber_count) AS min_subs, MAX(s.subscriber_count) AS max_subs
  FROM subscriber_snapshots s
  LEFT JOIN channels c ON c.id = s.channel_id
  WHERE s.source = 'socialblade_milestone'
  GROUP BY s.channel_id
  ORDER BY COUNT(*) ASC
  LIMIT 5
`).all();
console.log('\n=== 마일스톤 가장 적은 채널 5개 ===');
bottom5.forEach(r => console.log(
  `${(r.name || '(unknown)').padEnd(30)} ${r.milestones}건  ${r.min_subs.toLocaleString()} → ${r.max_subs.toLocaleString()}`
));

// 4. 날짜별 분포 — 매일 모든 채널이 있는지, 빠진 날짜가 있는지
const byDate = db.prepare(`
  SELECT DATE(polled_at) AS date, COUNT(*) AS channels
  FROM subscriber_snapshots
  WHERE source = 'socialblade_milestone'
  GROUP BY date
  ORDER BY date
`).all();
console.log(`\n=== 날짜별 채널 수 (${byDate.length}일 / 58일) ===`);
console.log('처음 5일:'); byDate.slice(0, 5).forEach(r => console.log(`  ${r.date}  ${r.channels}채널`));
console.log('마지막 5일:'); byDate.slice(-5).forEach(r => console.log(`  ${r.date}  ${r.channels}채널`));

// 5. ISSEI 전체 socialblade 행 보기
const issei = db.prepare(`
  SELECT polled_at, subscriber_count
  FROM subscriber_snapshots
  WHERE channel_id = 'UC6QZ_ss3i_8qLV_RczPZBkw' AND source = 'socialblade_milestone'
  ORDER BY polled_at
`).all();
console.log(`\n=== ISSEI의 socialblade 행 ${issei.length}건 ===`);
issei.forEach(r => console.log(`${r.polled_at.slice(0,10)}  ${r.subscriber_count.toLocaleString()}`));
