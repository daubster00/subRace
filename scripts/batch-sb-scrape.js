// 활성 채널 전체에 대해 SocialBlade 스크랩 + 마일스톤 INSERT 일괄 처리.
//   사전조건: chrome.exe --remote-debugging-port=9222 로 로그인 + CF 통과한 상태
//   usage:
//     node scripts/batch-sb-scrape.js [--limit=30] [--channels=N] [--skip=N] [--dry-run]
//       --limit    : 채널당 INSERT 할 최신 마일스톤 개수 (default 30)
//       --channels : 처리할 채널 수 제한 (default 전체)
//       --skip     : 첫 N개 채널 건너뜀 (재시작용)
//       --dry-run  : INSERT 안 함

const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'http://localhost:9222';
const DB_PATH = path.join('data', 'subrace.db');
const SOURCE = 'socialblade_milestone';

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const x = a.find(s => s.startsWith(`--${k}=`));
    return x ? parseInt(x.slice(k.length + 3), 10) : d;
  };
  return {
    limit: get('limit', 30),
    channels: get('channels', Infinity),
    skip: get('skip', 0),
    dryRun: a.includes('--dry-run'),
  };
}

async function switchToDaily(page) {
  const ddBtn = page
    .locator('button[id^="headlessui-listbox-button-"]')
    .filter({ hasText: /^(Monthly|Weekly|Daily)$/ })
    .first();
  await ddBtn.waitFor({ state: 'visible', timeout: 15000 });
  await ddBtn.scrollIntoViewIfNeeded();
  const curLabel = (await ddBtn.textContent()).trim();
  if (/^Daily$/.test(curLabel)) return;

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  await ddBtn.dispatchEvent('pointerdown');
  await page.waitForTimeout(60);
  await ddBtn.dispatchEvent('pointerup');
  await page.waitForTimeout(60);
  await ddBtn.dispatchEvent('click');
  await page.waitForTimeout(500);

  const dailyOpt = page.locator('[role="option"]', { hasText: /^Daily$/ }).first();
  await dailyOpt.click({ timeout: 6000 });
  await page.waitForTimeout(1800);
  const labelAfter = (await ddBtn.textContent()).trim();
  if (labelAfter !== 'Daily') {
    throw new Error(`dropdown stuck at "${labelAfter}"`);
  }
}

async function scrapeChannel(page, channelId) {
  const url = `https://socialblade.com/youtube/channel/${channelId}`;
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  // 앵커
  const anchorInfo = await page.evaluate(() => {
    const out = { exact: null, displayed: null };
    try {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (script) {
        const data = JSON.parse(script.textContent);
        const queries = data.props?.pageProps?.trpcState?.json?.queries || [];
        const userQ = queries.find(q =>
          Array.isArray(q.queryKey) && Array.isArray(q.queryKey[0]) &&
          q.queryKey[0][0] === 'youtube' && q.queryKey[0][1] === 'user'
        );
        if (userQ) out.exact = userQ.state?.data?.subscribers ?? null;
      }
    } catch {}
    const p = Array.from(document.querySelectorAll('p')).find(el =>
      /^\d+(\.\d+)?[KMB]$/i.test(el.textContent.trim()));
    if (p) out.displayed = p.textContent.trim();
    return out;
  });
  if (!anchorInfo.exact) throw new Error('anchor missing');

  // Detailed Charts 영역 보장
  const ddBtn = page
    .locator('button[id^="headlessui-listbox-button-"]')
    .filter({ hasText: /^(Monthly|Weekly|Daily)$/ })
    .first();
  await ddBtn.waitFor({ state: 'attached', timeout: 25000 });
  await ddBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);

  await switchToDaily(page);

  // echarts 대기
  await page.waitForSelector('[_echarts_instance_]', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(2000);

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
  if (!daily) throw new Error('Daily Gained Subscribers chart not found');

  const opt = JSON.parse(daily.optionStr);
  const series = opt.series || [];
  const data = series[0]?.data || [];

  const spikes = [];
  for (const item of data) {
    let date, delta;
    if (Array.isArray(item)) { [date, delta] = item; }
    else if (item && typeof item === 'object' && Array.isArray(item.value)) {
      [date, delta] = item.value;
    }
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
  const opts = parseArgs();
  console.log('options:', opts);

  const db = new Database(DB_PATH);
  const channels = db.prepare(`
    SELECT id, name FROM channels WHERE is_active = 1 ORDER BY id
  `).all();
  const targets = channels.slice(opts.skip, opts.skip + (Number.isFinite(opts.channels) ? opts.channels : channels.length));
  console.log(`target channels: ${targets.length} of ${channels.length} active`);

  console.log(`connecting CDP at ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no chrome context');
  const page = await ctx.newPage();

  const insertStmt = db.prepare(
    `INSERT INTO subscriber_snapshots (channel_id, polled_at, subscriber_count, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, polled_at) DO UPDATE SET
       subscriber_count = excluded.subscriber_count,
       source = excluded.source`
  );
  const deleteStmt = db.prepare(
    'DELETE FROM subscriber_snapshots WHERE channel_id = ? AND source = ?'
  );

  const report = { ok: [], failed: [], emptySpikes: [] };
  const startedAt = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const ch = targets[i];
    const idx = `[${i + 1}/${targets.length}]`;
    process.stdout.write(`${idx} ${ch.id} ${ch.name?.slice(0, 30) || ''} ... `);
    try {
      const { anchor, anchorDisplayed, spikes } = await scrapeChannel(page, ch.id);
      if (spikes.length === 0) {
        console.log(`anchor=${anchor.toLocaleString()} (${anchorDisplayed}) — no spikes, skip`);
        report.emptySpikes.push(ch.id);
        continue;
      }

      const milestones = computeMilestones(spikes, anchor).slice(-opts.limit);

      if (!opts.dryRun) {
        const tx = db.transaction(() => {
          deleteStmt.run(ch.id, SOURCE);
          for (const m of milestones) {
            insertStmt.run(ch.id, m.polled_at, m.subscriber_count, SOURCE);
          }
        });
        tx();
      }

      // 스파이크 JSON 저장 (재시도/디버깅용)
      fs.writeFileSync(
        path.join('data', `sb-chart-${ch.id}.json`),
        JSON.stringify({ channelId: ch.id, anchorSubscribers: anchor, anchorDisplayed, spikes }, null, 2)
      );

      console.log(`anchor=${anchor.toLocaleString()} spikes=${spikes.length} inserted=${milestones.length}`);
      report.ok.push(ch.id);
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
      report.failed.push({ id: ch.id, error: e.message });
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`ok          : ${report.ok.length}`);
  console.log(`empty spikes: ${report.emptySpikes.length}`);
  console.log(`failed      : ${report.failed.length}`);
  if (report.failed.length) {
    console.log('\nfailed channels:');
    report.failed.forEach(f => console.log(`  ${f.id}  ${f.error}`));
  }
  fs.writeFileSync(
    path.join('data', `sb-batch-report-${new Date().toISOString().slice(0,19).replace(/:/g,'')}.json`),
    JSON.stringify(report, null, 2)
  );

  await page.close();
  await browser.close();
  db.close();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
