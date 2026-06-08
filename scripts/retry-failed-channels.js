// 실패/빈 채널만 골라서 재시도 — 대기시간 늘림.
//   usage: node scripts/retry-failed-channels.js

const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'http://localhost:9222';
const DB_PATH = path.join('data', 'subrace.db');
const SOURCE = 'socialblade_milestone';
const LIMIT = 30;

const TARGETS = [
  // failed
  'UCCtALHup92q5xIFb7n9UXVg',
  'UCGCZAYq5Xxojl_tSXcVJhiQ',
  'UCibEhpu5HP45-w7Bq1ZIulw',
  'UCpFgmZm65yOU5X-hmWkWjuw',
  // empty spikes
  'UCCKJzBnveLS7oLpS8Q4m2eg',
  'UCEED1aBoGyJYlPYoSncmPmQ',
  'UCFTVNLC7ysej-sD5lkLqNGA',
  'UCg3qsVzHeUt5_cPpcRtoaJQ',
];

async function switchToDaily(page) {
  const ddBtn = page
    .locator('button[id^="headlessui-listbox-button-"]')
    .filter({ hasText: /^(Monthly|Weekly|Daily)$/ })
    .first();
  await ddBtn.waitFor({ state: 'visible', timeout: 25000 });
  await ddBtn.scrollIntoViewIfNeeded();
  const curLabel = (await ddBtn.textContent()).trim();
  if (/^Daily$/.test(curLabel)) return;

  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);   // 늘림

  await ddBtn.dispatchEvent('pointerdown');
  await page.waitForTimeout(120);
  await ddBtn.dispatchEvent('pointerup');
  await page.waitForTimeout(120);
  await ddBtn.dispatchEvent('click');
  await page.waitForTimeout(1500);   // 늘림

  const dailyOpt = page.locator('[role="option"]', { hasText: /^Daily$/ }).first();
  await dailyOpt.click({ timeout: 10000 });
  await page.waitForTimeout(4000);   // 늘림 — Daily 로 바뀌고 차트 그릴 시간
  const labelAfter = (await ddBtn.textContent()).trim();
  if (labelAfter !== 'Daily') throw new Error(`dropdown stuck at "${labelAfter}"`);
}

async function scrapeChannel(page, channelId) {
  await page.goto(`https://socialblade.com/youtube/channel/${channelId}`, {
    waitUntil: 'load', timeout: 90000,
  });

  const anchorInfo = await page.evaluate(() => {
    const out = { exact: null, displayed: null };
    try {
      const data = JSON.parse(document.querySelector('script#__NEXT_DATA__').textContent);
      const q = data.props?.pageProps?.trpcState?.json?.queries || [];
      const u = q.find(x => Array.isArray(x.queryKey) && Array.isArray(x.queryKey[0]) &&
        x.queryKey[0][0] === 'youtube' && x.queryKey[0][1] === 'user');
      if (u) out.exact = u.state?.data?.subscribers ?? null;
    } catch {}
    const p = Array.from(document.querySelectorAll('p')).find(el =>
      /^\d+(\.\d+)?[KMB]$/i.test(el.textContent.trim()));
    if (p) out.displayed = p.textContent.trim();
    return out;
  });
  if (!anchorInfo.exact) throw new Error('anchor missing');

  const ddBtn = page
    .locator('button[id^="headlessui-listbox-button-"]')
    .filter({ hasText: /^(Monthly|Weekly|Daily)$/ })
    .first();
  await ddBtn.waitFor({ state: 'attached', timeout: 30000 });
  await ddBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);

  await switchToDaily(page);

  await page.waitForSelector('[_echarts_instance_]', { state: 'attached', timeout: 30000 });
  await page.waitForTimeout(4500);   // 늘림 — 차트 hydration

  const charts = await page.evaluate(() => {
    function findInstViaFiber(el) {
      const k = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (!k) return null;
      let f = el[k];
      while (f) {
        const sn = f.stateNode;
        if (sn && typeof sn === 'object') {
          if (sn.echartsInstance) return sn.echartsInstance;
          if (typeof sn.getEchartsInstance === 'function') {
            try { return sn.getEchartsInstance(); } catch {}
          }
        }
        f = f.return;
      }
      return null;
    }
    const out = [];
    for (const el of document.querySelectorAll('[_echarts_instance_]')) {
      let header = '', n = el;
      for (let i = 0; i < 6 && n; i++) {
        n = n.parentElement; if (!n) break;
        const h = n.querySelector('h2');
        if (h) { header = h.textContent.trim(); break; }
      }
      const inst = findInstViaFiber(el);
      if (!inst) { out.push({ header, optionStr: null }); continue; }
      try { out.push({ header, optionStr: JSON.stringify(inst.getOption()) }); }
      catch (e) { out.push({ header, optionStr: `ERROR: ${e.message}` }); }
    }
    return out;
  });

  const daily = charts.find(c =>
    /daily gained subscribers/i.test(c.header) && c.optionStr && !c.optionStr.startsWith('ERROR')
  );
  if (!daily) {
    const headers = charts.map(c => c.header);
    throw new Error('Daily chart not found. headers: ' + JSON.stringify(headers));
  }

  const opt = JSON.parse(daily.optionStr);
  const data = opt.series?.[0]?.data || [];
  const spikes = [];
  for (const item of data) {
    let date, delta;
    if (Array.isArray(item)) [date, delta] = item;
    else if (item?.value) [date, delta] = item.value;
    if (typeof delta === 'number' && delta > 0) {
      spikes.push({
        date: typeof date === 'number' ? new Date(date).toISOString() : date,
        delta,
      });
    }
  }
  return { anchor: anchorInfo.exact, anchorDisplayed: anchorInfo.displayed, spikes };
}

function computeMilestones(spikes, anchor) {
  const rows = [];
  let cur = anchor;
  for (let i = spikes.length - 1; i >= 0; i--) {
    rows.push({ polled_at: spikes[i].date, subscriber_count: cur });
    cur -= Number(spikes[i].delta);
  }
  return rows.reverse();
}

async function main() {
  const db = new Database(DB_PATH);
  const insertStmt = db.prepare(
    `INSERT INTO subscriber_snapshots (channel_id, polled_at, subscriber_count, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, polled_at) DO UPDATE SET
       subscriber_count = excluded.subscriber_count, source = excluded.source`
  );
  const deleteStmt = db.prepare(
    'DELETE FROM subscriber_snapshots WHERE channel_id = ? AND source = ?'
  );

  console.log(`connecting CDP...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  const ok = [], stillFailed = [];
  for (let i = 0; i < TARGETS.length; i++) {
    const id = TARGETS[i];
    const name = db.prepare('SELECT name FROM channels WHERE id=?').get(id)?.name || '?';
    process.stdout.write(`[${i+1}/${TARGETS.length}] ${id} ${name.slice(0,30)} ... `);
    try {
      const { anchor, anchorDisplayed, spikes } = await scrapeChannel(page, id);
      if (spikes.length === 0) {
        console.log(`anchor=${anchor.toLocaleString()} — no spikes`);
        stillFailed.push({ id, reason: 'no spikes' });
        continue;
      }
      const milestones = computeMilestones(spikes, anchor).slice(-LIMIT);
      db.transaction(() => {
        deleteStmt.run(id, SOURCE);
        for (const m of milestones) insertStmt.run(id, m.polled_at, m.subscriber_count, SOURCE);
      })();
      fs.writeFileSync(
        path.join('data', `sb-chart-${id}.json`),
        JSON.stringify({ channelId: id, anchorSubscribers: anchor, anchorDisplayed, spikes }, null, 2)
      );
      console.log(`anchor=${anchor.toLocaleString()} spikes=${spikes.length} inserted=${milestones.length}`);
      ok.push(id);
    } catch (e) {
      console.log(`FAIL: ${e.message.slice(0, 200)}`);
      stillFailed.push({ id, reason: e.message });
    }
  }

  console.log(`\n=== retry summary ===`);
  console.log('recovered:', ok.length);
  console.log('still failed:', stillFailed.length);
  stillFailed.forEach(f => console.log('  ' + f.id + '  ' + f.reason.slice(0, 100)));

  await page.close();
  await browser.close();
  db.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
