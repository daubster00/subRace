// 마일스톤(source='socialblade_milestone')이 10개 이하인 채널만 골라 재스크랩.
//   사전조건: start-sb-chrome.ps1 로 띄운 chrome (--remote-debugging-port=9222) 에서
//             socialblade 로그인 + CF 통과한 상태.
//   동작:
//     1) DB에서 milestone COUNT ≤ 10 인 채널 자동 조회 (active 채널 한정)
//     2) 채널별로 SB 페이지 스크랩 → __NEXT_DATA__ anchor + Daily Gained echarts 추출
//     3) 기존 socialblade_milestone 행 DELETE 후 역산 마일스톤 재INSERT (중복 방지)
//     4) 채널별 결과 리포트 출력
//   usage:
//     node scripts/rescrape-low-milestone-channels.js [--threshold=10] [--limit=30] [--dry-run]
//       --threshold : 재스크랩 대상 milestone 개수 상한 (default 10, 이 값 이하인 채널만)
//       --limit     : 채널당 INSERT 할 최신 마일스톤 개수 (default 30)
//       --dry-run   : 조회/스크랩만, DELETE+INSERT 안 함

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
    threshold: get('threshold', 10),
    limit: get('limit', 30),
    dryRun: a.includes('--dry-run'),
  };
}

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
  await page.waitForTimeout(2500);

  await ddBtn.dispatchEvent('pointerdown');
  await page.waitForTimeout(120);
  await ddBtn.dispatchEvent('pointerup');
  await page.waitForTimeout(120);
  await ddBtn.dispatchEvent('click');
  await page.waitForTimeout(1500);

  const dailyOpt = page.locator('[role="option"]', { hasText: /^Daily$/ }).first();
  await dailyOpt.click({ timeout: 10000 });
  await page.waitForTimeout(4000);
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
  await page.waitForTimeout(4500);   // 차트 hydration

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
  // spikes는 chronological order (chart에서 그대로 옴).
  // 최신 spike → anchor 로 두고 역산.
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

  // 마일스톤 COUNT ≤ threshold 인 active 채널 조회 (0개 채널도 포함 — LEFT JOIN).
  const targets = db.prepare(`
    SELECT c.id, c.name, COUNT(s.channel_id) AS milestone_count
    FROM channels c
    LEFT JOIN subscriber_snapshots s
      ON s.channel_id = c.id AND s.source = @source
    WHERE c.is_active = 1
    GROUP BY c.id, c.name
    HAVING milestone_count <= @threshold
    ORDER BY milestone_count ASC, c.id
  `).all({ source: SOURCE, threshold: opts.threshold });

  console.log(`target channels (milestone_count <= ${opts.threshold}): ${targets.length}`);
  targets.forEach(t =>
    console.log(`  ${t.id}  ${(t.name || '?').slice(0, 30).padEnd(30)}  current=${t.milestone_count}`)
  );
  if (targets.length === 0) {
    console.log('nothing to do.');
    db.close();
    return;
  }

  const insertStmt = db.prepare(
    `INSERT INTO subscriber_snapshots (channel_id, polled_at, subscriber_count, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, polled_at) DO UPDATE SET
       subscriber_count = excluded.subscriber_count, source = excluded.source`
  );
  const deleteStmt = db.prepare(
    'DELETE FROM subscriber_snapshots WHERE channel_id = ? AND source = ?'
  );

  console.log(`\nconnecting CDP at ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no chrome context');
  const page = await ctx.newPage();

  const report = [];   // { id, name, before, status, anchor, spikes, deleted, inserted, error }
  const startedAt = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const ch = targets[i];
    const idx = `[${i + 1}/${targets.length}]`;
    process.stdout.write(`${idx} ${ch.id} ${(ch.name || '').slice(0, 30)} (was ${ch.milestone_count}) ... `);

    const row = {
      id: ch.id, name: ch.name, before: ch.milestone_count,
      status: null, anchor: null, spikes: 0, deleted: 0, inserted: 0, error: null,
    };

    try {
      const { anchor, anchorDisplayed, spikes } = await scrapeChannel(page, ch.id);
      row.anchor = anchor;
      row.spikes = spikes.length;

      if (spikes.length === 0) {
        console.log(`anchor=${anchor.toLocaleString()} (${anchorDisplayed}) — no spikes, skip`);
        row.status = 'no_spikes';
        report.push(row);
        continue;
      }

      const milestones = computeMilestones(spikes, anchor).slice(-opts.limit);

      if (!opts.dryRun) {
        db.transaction(() => {
          const del = deleteStmt.run(ch.id, SOURCE);
          row.deleted = del.changes;
          for (const m of milestones) {
            insertStmt.run(ch.id, m.polled_at, m.subscriber_count, SOURCE);
          }
          row.inserted = milestones.length;
        })();
      } else {
        row.inserted = milestones.length; // dry-run: 예상치
      }

      // 스파이크 JSON 저장 (재시도/디버깅용)
      fs.writeFileSync(
        path.join('data', `sb-chart-${ch.id}.json`),
        JSON.stringify({ channelId: ch.id, anchorSubscribers: anchor, anchorDisplayed, spikes }, null, 2)
      );

      console.log(
        `anchor=${anchor.toLocaleString()} spikes=${spikes.length} ` +
        `deleted=${row.deleted} inserted=${row.inserted}${opts.dryRun ? ' (dry-run)' : ''}`
      );
      row.status = 'ok';
      report.push(row);
    } catch (e) {
      console.log(`FAIL: ${e.message.slice(0, 200)}`);
      row.status = 'failed';
      row.error = e.message;
      report.push(row);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const ok = report.filter(r => r.status === 'ok');
  const noSpikes = report.filter(r => r.status === 'no_spikes');
  const failed = report.filter(r => r.status === 'failed');

  console.log(`\n=== rescrape summary (${elapsed}s) ===`);
  console.log(`ok          : ${ok.length}`);
  console.log(`no spikes   : ${noSpikes.length}`);
  console.log(`failed      : ${failed.length}`);

  console.log(`\n=== per-channel report ===`);
  console.log('status     before -> inserted  channel');
  for (const r of report) {
    const after = r.status === 'ok' ? r.inserted : r.before;
    const arrow = `${String(r.before).padStart(3)} -> ${String(after).padStart(3)}`;
    console.log(
      `${(r.status || '').padEnd(10)} ${arrow}  ${r.id}  ${(r.name || '?').slice(0, 28)}` +
      (r.error ? `  [${r.error.slice(0, 60)}]` : '')
    );
  }

  // 리포트 파일 저장
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '');
  fs.writeFileSync(
    path.join('data', `sb-rescrape-report-${stamp}.json`),
    JSON.stringify({ options: opts, elapsedSec: Number(elapsed), report }, null, 2)
  );
  console.log(`\nreport saved: data/sb-rescrape-report-${stamp}.json`);

  await page.close();
  await browser.close();
  db.close();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
