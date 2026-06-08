// SocialBlade 채널 페이지의 "Daily Gained Subscribers" 차트(echarts)에서
// 마일스톤 스파이크(+10K 도달일)를 추출한다.
//   사전조건: chrome.exe --remote-debugging-port=9222 로 띄워서 로그인 + CF 통과한 상태
//   usage: node scripts/scrape-sb-chart.js <CHANNEL_ID>

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'http://localhost:9222';

async function switchToDaily(page) {
  const ddBtn = page
    .locator('button[id^="headlessui-listbox-button-"]')
    .filter({ hasText: /^(Monthly|Weekly|Daily)$/ })
    .first();
  await ddBtn.waitFor({ state: 'visible', timeout: 15000 });
  await ddBtn.scrollIntoViewIfNeeded();
  const curLabel = (await ddBtn.textContent()).trim();
  console.log('chart dropdown current:', curLabel);
  if (/^Daily$/.test(curLabel)) return;

  // hydration 대기
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Headless UI Listbox 열기 — pointer event 시퀀스가 가장 안정적
  await ddBtn.dispatchEvent('pointerdown');
  await page.waitForTimeout(80);
  await ddBtn.dispatchEvent('pointerup');
  await page.waitForTimeout(80);
  await ddBtn.dispatchEvent('click');
  await page.waitForTimeout(700);
  const expanded = await ddBtn.getAttribute('aria-expanded');
  console.log('listbox aria-expanded=', expanded);

  // 옵션 클릭 — 실제 mouse click (headless:false 전제)
  const dailyOpt = page.locator('[role="option"]', { hasText: /^Daily$/ }).first();
  await dailyOpt.click({ timeout: 8000 });
  await page.waitForTimeout(2500);
  const labelAfter = (await ddBtn.textContent()).trim();
  console.log('dropdown after switch:', labelAfter);
  if (labelAfter !== 'Daily') {
    throw new Error(`Failed to switch dropdown — still "${labelAfter}"`);
  }
}

async function main() {
  const channelId = process.argv[2];
  if (!channelId) {
    console.error('Usage: node scrape-sb-chart.js <CHANNEL_ID>');
    process.exit(1);
  }

  console.log(`connecting to chrome via CDP at ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0]; // 사용자가 띄운 기존 컨텍스트 그대로 사용
  if (!ctx) throw new Error('no existing context on attached chrome');
  const page = await ctx.newPage();

  // 채널 페이지 진입
  const url = `https://socialblade.com/youtube/channel/${channelId}`;
  console.log(`navigating to ${url}`);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  console.log('title:', await page.title());

  // 앵커 추출 — __NEXT_DATA__ 의 youtube.user.subscribers (정확 정수)
  //                + displayed 텍스트 "4.13M" 도 같이 (대조용)
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
    // displayed
    const p = document.querySelector('p.text-\\[1\\.25em\\].font-extralight') ||
              Array.from(document.querySelectorAll('p')).find(el =>
                /^\d+(\.\d+)?[KMB]$/i.test(el.textContent.trim()));
    if (p) out.displayed = p.textContent.trim();
    return out;
  });
  console.log('anchor:', JSON.stringify(anchorInfo));
  if (!anchorInfo.exact) {
    throw new Error('failed to extract anchor subscribers from __NEXT_DATA__');
  }

  // 3) Detailed Charts 영역까지 스크롤 (dropdown이 viewport에 들어와야 보임)
  const ddBtn = page
    .locator('button[id^="headlessui-listbox-button-"]')
    .filter({ hasText: /^(Monthly|Weekly|Daily)$/ })
    .first();
  await ddBtn.waitFor({ state: 'attached', timeout: 30000 });
  await ddBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);

  // 4) Daily로 전환
  await switchToDaily(page);

  // 5) echarts 인스턴스 대기 후 데이터 추출
  await page.waitForSelector('[_echarts_instance_]', { state: 'attached', timeout: 30000 });
  await page.waitForTimeout(3000);

  const charts = await page.evaluate(() => {
    // window 안에서 getInstanceByDom 메서드 가진 echarts 모듈 찾기
    let ec = window.echarts || (typeof echarts !== 'undefined' ? echarts : null);
    if (!ec) {
      for (const k of Object.keys(window)) {
        try {
          const v = window[k];
          if (v && typeof v === 'object' && typeof v.getInstanceByDom === 'function') {
            ec = v; break;
          }
        } catch {}
      }
    }

    // React fiber로부터 echarts-for-react 컴포넌트의 echartsInstance 직접 추출
    function findEChartsInstanceViaFiber(el) {
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return null;
      let fiber = el[fiberKey];
      // 부모 fiber로 올라가면서 echartsInstance 프로퍼티 가진 stateNode 검색
      while (fiber) {
        const sn = fiber.stateNode;
        if (sn && typeof sn === 'object') {
          // echarts-for-react 컴포넌트 인스턴스
          if (sn.echartsInstance) return sn.echartsInstance;
          if (sn.getEchartsInstance && typeof sn.getEchartsInstance === 'function') {
            try { return sn.getEchartsInstance(); } catch {}
          }
        }
        fiber = fiber.return;
      }
      return null;
    }

    const out = [];
    const els = document.querySelectorAll('[_echarts_instance_]');
    for (const el of els) {
      let header = '';
      let node = el;
      for (let i = 0; i < 6 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const h = node.querySelector('h2');
        if (h) { header = h.textContent.trim(); break; }
      }
      const instId = el.getAttribute('_echarts_instance_');
      let optionStr = null;
      let how = null;
      try {
        let inst = null;
        if (ec) {
          inst = ec.getInstanceByDom(el);
          if (inst) how = 'getInstanceByDom';
        }
        if (!inst) {
          inst = findEChartsInstanceViaFiber(el);
          if (inst) how = 'reactFiber';
        }
        if (inst) optionStr = JSON.stringify(inst.getOption());
      } catch (e) { optionStr = `ERROR: ${e.message}`; }
      out.push({ header, instId, optionStr, how });
    }
    return { ecFound: !!ec, charts: out };
  });

  console.log('ec global found:', charts.ecFound);
  const chartList = charts.charts;

  console.log(`\nfound ${chartList.length} charts:`);
  chartList.forEach((c, i) => {
    console.log(`  [${i}] header="${c.header}" instId=${c.instId} how=${c.how} ${
      c.optionStr ? `(${c.optionStr.length}B)` : '(no data)'
    }`);
  });

  const daily = chartList.find(c =>
    /daily gained subscribers/i.test(c.header) && c.optionStr && !c.optionStr.startsWith('ERROR')
  );
  if (!daily) {
    fs.writeFileSync(path.join('data', `sb-charts-${channelId}-all.json`), JSON.stringify(chartList, null, 2));
    console.log('Daily Gained Subscribers 차트 옵션을 못 얻음. 전체 덤프 저장.');
    await browser.close();
    return;
  }

  const opt = JSON.parse(daily.optionStr);
  fs.writeFileSync(path.join('data', `sb-chart-raw-${channelId}.json`), JSON.stringify(opt, null, 2));
  const xAxis = opt.xAxis?.[0]?.data || [];
  const series = opt.series || [];
  console.log('\n=== Daily Gained Subscribers ===');
  console.log('xAxis (count):', xAxis.length);
  console.log('xAxis sample:', JSON.stringify(xAxis.slice(0, 3)), '...', JSON.stringify(xAxis.slice(-3)));
  console.log('xAxis keys:', Object.keys(opt.xAxis?.[0] || {}));
  series.forEach((s, i) => {
    console.log(`series[${i}] name="${s.name}" type=${s.type} dataLen=${(s.data || []).length}`);
    if ((s.data || []).length) {
      console.log(`  data[0..2]:`, JSON.stringify(s.data.slice(0, 3)));
      console.log(`  data[-3..]:`, JSON.stringify(s.data.slice(-3)));
    }
  });

  // 데이터 포맷 자동 감지:
  //   (a) parallel: xAxis.data + series.data       → [{date: xAxis[i], delta: data[i]}]
  //   (b) inline:   series.data = [[date, val],..] → [{date, delta}]
  //   (c) object:   series.data = [{value:[date,val]},...]
  const dataArr = series[0]?.data || [];
  const rows = [];
  if (xAxis.length && dataArr.length) {
    for (let i = 0; i < xAxis.length; i++) {
      rows.push({ date: xAxis[i], delta: dataArr[i] });
    }
  } else if (dataArr.length) {
    for (const item of dataArr) {
      let date, delta;
      if (Array.isArray(item)) { [date, delta] = item; }
      else if (item && typeof item === 'object' && Array.isArray(item.value)) {
        [date, delta] = item.value;
      } else if (item && typeof item === 'object') {
        date = item.date || item.x || item.name;
        delta = item.value ?? item.y;
      }
      rows.push({ date, delta });
    }
  }

  // 스파이크만 추출 (delta > 0) + 타임스탬프 → ISO
  const spikes = rows
    .filter(r => Number(r.delta) > 0)
    .map(r => ({
      date: typeof r.date === 'number'
        ? new Date(r.date).toISOString()
        : r.date,
      delta: Number(r.delta),
    }));

  console.log(`\nspikes (delta > 0): ${spikes.length}`);

  const outPath = path.join('data', `sb-chart-${channelId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    channelId,
    fetchedAt: new Date().toISOString(),
    anchorSubscribers: anchorInfo.exact,
    anchorDisplayed: anchorInfo.displayed,
    header: daily.header,
    spikeCount: spikes.length,
    spikes,
  }, null, 2));
  console.log(`saved spikes → ${outPath}`);

  await page.close();           // CDP attach 모드 — browser는 사용자 소유라 close 금지
  await browser.close();        // 우리 측 연결만 끊김
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
