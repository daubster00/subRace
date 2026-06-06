// 한 채널만 처리 (실패 채널 마지막 클린업용)
//   usage: node scripts/single-channel-scrape.js <CHANNEL_ID>

const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'http://localhost:9222';
const DB_PATH = path.join('data', 'subrace.db');
const SOURCE = 'socialblade_milestone';
const LIMIT = 30;

async function switchToDaily(page) {
  const ddBtn = page
    .locator('button[id^="headlessui-listbox-button-"]')
    .filter({ hasText: /^(Monthly|Weekly|Daily)$/ })
    .first();
  await ddBtn.waitFor({ state: 'visible', timeout: 30000 });
  await ddBtn.scrollIntoViewIfNeeded();
  const cur = (await ddBtn.textContent()).trim();
  if (/^Daily$/.test(cur)) return;
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await ddBtn.dispatchEvent('pointerdown');
  await page.waitForTimeout(150);
  await ddBtn.dispatchEvent('pointerup');
  await page.waitForTimeout(150);
  await ddBtn.dispatchEvent('click');
  await page.waitForTimeout(2000);
  await page.locator('[role="option"]', { hasText: /^Daily$/ }).first().click({ timeout: 15000 });
  await page.waitForTimeout(5000);
}

(async () => {
  const id = process.argv[2];
  if (!id) { console.error('id required'); process.exit(1); }

  const db = new Database(DB_PATH);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = await browser.contexts()[0].newPage();

  console.log(`scraping ${id}...`);
  await page.goto(`https://socialblade.com/youtube/channel/${id}`, { waitUntil: 'load', timeout: 180000 });
  console.log('loaded.');

  const anchor = await page.evaluate(() => {
    const data = JSON.parse(document.querySelector('script#__NEXT_DATA__').textContent);
    const q = data.props.pageProps.trpcState.json.queries;
    const u = q.find(x => Array.isArray(x.queryKey) && x.queryKey[0]?.[0]==='youtube' && x.queryKey[0]?.[1]==='user');
    return u?.state?.data?.subscribers;
  });
  console.log('anchor:', anchor);

  await page.locator('button[id^="headlessui-listbox-button-"]').filter({ hasText: /^(Monthly|Weekly|Daily)$/ }).first()
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(3000);
  await switchToDaily(page);
  await page.waitForSelector('[_echarts_instance_]', { state: 'attached', timeout: 30000 });
  await page.waitForTimeout(5000);

  const series = await page.evaluate(() => {
    function find(el) {
      const k = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      let f = el[k];
      while (f) {
        const sn = f.stateNode;
        if (sn?.echartsInstance) return sn.echartsInstance;
        if (typeof sn?.getEchartsInstance === 'function') return sn.getEchartsInstance();
        f = f.return;
      }
      return null;
    }
    for (const el of document.querySelectorAll('[_echarts_instance_]')) {
      let h='', n=el;
      for (let i=0;i<6&&n;i++) { n=n.parentElement; if (!n) break; const hh=n.querySelector('h2'); if(hh){h=hh.textContent.trim();break;} }
      if (!/daily gained subscribers/i.test(h)) continue;
      const inst = find(el);
      if (!inst) continue;
      const o = inst.getOption();
      return o.series?.[0]?.data || [];
    }
    return null;
  });
  if (!series) throw new Error('chart not found');
  console.log('series data points:', series.length);

  const spikes = [];
  for (const it of series) {
    let d, v;
    if (Array.isArray(it)) [d, v] = it;
    else if (it?.value) [d, v] = it.value;
    if (typeof v === 'number' && v > 0) {
      spikes.push({ date: typeof d === 'number' ? new Date(d).toISOString() : d, delta: v });
    }
  }
  console.log('spikes:', spikes.length);

  if (spikes.length === 0) { console.log('no spikes — done.'); return; }

  const rows = [];
  let cur = anchor;
  for (let i = spikes.length - 1; i >= 0; i--) {
    rows.push({ polled_at: spikes[i].date, subscriber_count: cur });
    cur -= spikes[i].delta;
  }
  const milestones = rows.reverse().slice(-LIMIT);

  db.transaction(() => {
    db.prepare('DELETE FROM subscriber_snapshots WHERE channel_id=? AND source=?').run(id, SOURCE);
    const ins = db.prepare('INSERT INTO subscriber_snapshots (channel_id, polled_at, subscriber_count, source) VALUES (?,?,?,?)');
    for (const m of milestones) ins.run(id, m.polled_at, m.subscriber_count, SOURCE);
  })();
  fs.writeFileSync(path.join('data', `sb-chart-${id}.json`),
    JSON.stringify({ channelId: id, anchorSubscribers: anchor, spikes }, null, 2));
  console.log('inserted', milestones.length, 'rows.');

  await page.close();
  await browser.close();
  db.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
