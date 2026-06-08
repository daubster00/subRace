// SocialBlade 채널 페이지의 __NEXT_DATA__ 에서 youtube.history (Daily Gained) 추출.
//   usage: node scripts/extract-sb-history.js <CHANNEL_ID>

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const channelId = process.argv[2];
if (!channelId) {
  console.error('Usage: node extract-sb-history.js <CHANNEL_ID>');
  process.exit(1);
}

const url = `https://socialblade.com/youtube/channel/${channelId}`;
const html = execSync(
  `curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" -H "Accept: text/html" "${url}"`,
  { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
);

const marker = '<script id="__NEXT_DATA__" type="application/json">';
const start = html.indexOf(marker);
if (start < 0) throw new Error('__NEXT_DATA__ not found');
const jsonStart = start + marker.length;
const jsonEnd = html.indexOf('</script>', jsonStart);
const json = html.slice(jsonStart, jsonEnd);

const data = JSON.parse(json);
const queries = data.props.pageProps.trpcState.json.queries;

// history query 찾기
const historyQuery = queries.find(q =>
  Array.isArray(q.queryKey) && Array.isArray(q.queryKey[0]) &&
  q.queryKey[0][0] === 'youtube' && q.queryKey[0][1] === 'history'
);
if (!historyQuery) throw new Error('history query not found');

const userQuery = queries.find(q =>
  Array.isArray(q.queryKey) && Array.isArray(q.queryKey[0]) &&
  q.queryKey[0][0] === 'youtube' && q.queryKey[0][1] === 'user'
);

console.log('=== current subscribers (from user query) ===');
console.log(userQuery.state.data.subscribers);

console.log('\n=== history rows (raw) ===');
const rows = historyQuery.state.data;
rows.forEach(r => console.log(r));

// 결과 저장
const outPath = path.join('data', `sb-history-${channelId}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  channelId,
  fetchedAt: new Date().toISOString(),
  currentSubscribers: userQuery.state.data.subscribers,
  history: rows,
}, null, 2));
console.log(`\nSaved to ${outPath}`);
