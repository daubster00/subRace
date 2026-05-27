const Database = require('better-sqlite3');
const db = new Database('./data/subrace.db', { readonly: true });

// 중복 정리 시뮬레이션: (channel_id, subscriber_count) 단위로 묶고 polled_at 최소만 남김
const dedupCount = db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT channel_id, subscriber_count
    FROM subscriber_snapshots
    GROUP BY channel_id, subscriber_count
  )
`).get();
console.log('=== 중복 정리 후 예상 행 수 ===');
console.log(`distinct (channel_id, subscriber_count) 조합 = ${dedupCount.n}`);
console.log(`현재 행 수 43,719 → 약 ${dedupCount.n}행으로 축소 (삭제: ${43719 - dedupCount.n}행)`);

// 채널별 남는 행 수 분포
const perChannel = db.prepare(`
  SELECT
    MIN(c) AS min_rows, MAX(c) AS max_rows, ROUND(AVG(c), 1) AS avg_rows,
    COUNT(*) AS channels
  FROM (
    SELECT channel_id, COUNT(DISTINCT subscriber_count) AS c
    FROM subscriber_snapshots
    GROUP BY channel_id
  )
`).get();
console.log('\n=== 중복 정리 후 채널당 남는 행 수 ===');
console.log(perChannel);

// ISSEI의 중복 정리 후 행 미리보기
const isseiDedupe = db.prepare(`
  SELECT MIN(polled_at) AS first_seen_at, subscriber_count, COUNT(*) AS dup_count
  FROM subscriber_snapshots
  WHERE channel_id = 'UC6QZ_ss3i_8qLV_RczPZBkw'
  GROUP BY subscriber_count
  ORDER BY first_seen_at
`).all();
console.log('\n=== ISSEI 중복 정리 후 (마일스톤 첫 도달 시점) ===');
isseiDedupe.forEach(r =>
  console.log(`${r.first_seen_at}  ${r.subscriber_count.toLocaleString()}  (중복 ${r.dup_count}건)`)
);
