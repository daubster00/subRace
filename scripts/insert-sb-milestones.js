// data/sb-chart-<channelId>.json 의 스파이크를 역산해 subscriber_snapshots 에 INSERT.
//   anchor = poll_state.api_subscriber_count (현재 구독자 수)
//   walking back: spike[i] 의 마일스톤 값 = anchor - sum(spike[i+1..N-1].delta)
//   기존 source='socialblade_milestone' 행은 DELETE 후 재삽입.
//
//   usage:
//     node scripts/insert-sb-milestones.js <CHANNEL_ID> [--dry-run] [--limit=30]

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join('data', 'subrace.db');
const SOURCE = 'socialblade_milestone';

function parseArgs() {
  const args = process.argv.slice(2);
  const channelId = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.slice('--limit='.length), 10) : 30;
  return { channelId, dryRun, limit };
}

function computeMilestones(spikes, anchor) {
  // spikes는 chronological order로 정렬돼있어야 함 (chart에서 그대로 옴)
  // walking back from the most recent: spike[N-1] -> anchor
  const rows = [];
  let cur = anchor;
  for (let i = spikes.length - 1; i >= 0; i--) {
    rows.push({ polled_at: spikes[i].date, subscriber_count: cur });
    cur -= Number(spikes[i].delta);
  }
  // chronological (oldest first) — INSERT 순서 자연스럽게
  return rows.reverse();
}

function main() {
  const { channelId, dryRun, limit } = parseArgs();
  if (!channelId) {
    console.error('Usage: node insert-sb-milestones.js <CHANNEL_ID> [--dry-run] [--limit=30]');
    process.exit(1);
  }

  const spikesPath = path.join('data', `sb-chart-${channelId}.json`);
  if (!fs.existsSync(spikesPath)) {
    console.error(`spikes file not found: ${spikesPath}`);
    process.exit(1);
  }
  const { spikes, anchorSubscribers } = JSON.parse(fs.readFileSync(spikesPath, 'utf8'));
  if (!spikes || spikes.length === 0) {
    console.log(`no spikes for ${channelId} — skipping`);
    return;
  }
  if (!anchorSubscribers) {
    console.error(`anchorSubscribers missing in ${spikesPath}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  const anchor = anchorSubscribers;
  console.log(`anchor (from scraped page) = ${anchor.toLocaleString()}`);
  console.log(`total spikes = ${spikes.length}`);

  const allMilestones = computeMilestones(spikes, anchor);
  const milestones = allMilestones.slice(-limit); // 최신 N개만 (chronological 끝쪽)
  console.log(`limit = ${limit}, inserting ${milestones.length} rows`);
  console.log('\nfirst 3 of new rows:');
  milestones.slice(0, 3).forEach(r =>
    console.log(`  ${r.polled_at.slice(0,10)}  ${r.subscriber_count.toLocaleString()}`)
  );
  console.log('last 3 of new rows:');
  milestones.slice(-3).forEach(r =>
    console.log(`  ${r.polled_at.slice(0,10)}  ${r.subscriber_count.toLocaleString()}`)
  );

  // 기존 socialblade_milestone 행 확인
  const existing = db.prepare(
    `SELECT polled_at, subscriber_count FROM subscriber_snapshots
     WHERE channel_id = ? AND source = ? ORDER BY polled_at`
  ).all(channelId, SOURCE);
  console.log(`\nexisting socialblade_milestone rows for this channel: ${existing.length}`);
  existing.forEach(r =>
    console.log(`  ${r.polled_at.slice(0,10)}  ${r.subscriber_count.toLocaleString()}`)
  );

  if (dryRun) {
    console.log('\n[--dry-run] skipping DELETE + INSERT.');
    db.close();
    return;
  }

  const tx = db.transaction(() => {
    const del = db.prepare(
      'DELETE FROM subscriber_snapshots WHERE channel_id = ? AND source = ?'
    ).run(channelId, SOURCE);
    console.log(`\nDELETE socialblade_milestone: ${del.changes} rows`);

    const ins = db.prepare(
      `INSERT INTO subscriber_snapshots (channel_id, polled_at, subscriber_count, source)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id, polled_at) DO UPDATE SET
         subscriber_count = excluded.subscriber_count,
         source = excluded.source`
    );
    let inserted = 0;
    for (const m of milestones) {
      ins.run(channelId, m.polled_at, m.subscriber_count, SOURCE);
      inserted++;
    }
    console.log(`INSERT socialblade_milestone: ${inserted} rows`);
  });
  tx();
  db.close();
  console.log('\ndone.');
}

main();
