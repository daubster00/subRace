// 새로 깔린 미적용 이벤트의 magnitude 분포 점검.
// distributeRandom이 정말 적용됐는지 (=절대값 unique 수 / 히스토그램) 확인.
import Database from 'better-sqlite3';

const db = new Database('./data/subrace.db', { readonly: true });

const total = db.prepare('SELECT COUNT(*) AS n FROM display_event_schedule WHERE applied = 0').get().n;
const channels = db.prepare('SELECT COUNT(DISTINCT channel_id) AS n FROM display_event_schedule WHERE applied = 0').get().n;
console.log(`unapplied events: ${total} across ${channels} channels\n`);

// 전체 magnitude 분포
const hist = db.prepare(`
  SELECT ABS(magnitude) AS m, COUNT(*) AS c
  FROM display_event_schedule WHERE applied = 0
  GROUP BY ABS(magnitude) ORDER BY m
`).all();
console.log('global |mag| histogram:');
for (const r of hist) console.log(`  ${String(r.m).padStart(3)} : ${r.c}`);

// 채널 6개 샘플: 가장 이벤트 많은 채널들
const top = db.prepare(`
  SELECT channel_id, COUNT(*) AS n
  FROM display_event_schedule WHERE applied = 0
  GROUP BY channel_id ORDER BY n DESC LIMIT 6
`).all();
console.log('\nsample channels (top by event count):');
for (const t of top) {
  const mags = db.prepare(`
    SELECT magnitude FROM display_event_schedule
    WHERE channel_id = ? AND applied = 0 ORDER BY scheduled_at
  `).all(t.channel_id).map((r) => r.magnitude);
  const uniq = new Set(mags.map((m) => Math.abs(m)));
  const sum = mags.reduce((a, b) => a + b, 0);
  const pos = mags.filter((m) => m > 0).length;
  const neg = mags.filter((m) => m < 0).length;
  console.log(`  ${t.channel_id} | n=${mags.length} | sum=${sum} | trend=${pos} counter=${neg} | uniq |mag|=${uniq.size} (${[...uniq].sort((a,b)=>a-b).join(',')})`);
}

db.close();
