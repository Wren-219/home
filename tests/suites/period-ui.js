const { chromiumPath } = require('../lib/env');
const { chromium } = require('playwright-core'); const fs = require('fs');
(async () => {
  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2200);
  await page.click('.tab[data-page="settings"]'); await page.waitForTimeout(900);
  const entry = page.locator(".set-card:has-text(\"她的身体\") button");
  ok(await entry.isVisible(), '设置页有「她的身体」入口');
  await entry.click(); await page.waitForTimeout(900);

  console.log('\n[她自己看到的]');
  const now = await page.locator('#perNow').textContent();
  const sub = await page.locator('#perSub').textContent();
  console.log('      大字：' + now);
  console.log('      小字：' + sub);
  ok(/6\s*天|9月29|09-29/.test(now + sub), '算出了下次是 6 天后（09-29）');
  const stat = await page.locator('#perStat').textContent();
  console.log('      怎么算的：' + stat);
  ok(/29/.test(stat), '周期算成 29 天（她自己四次记录推出来的）');
  const rows = await page.locator('#perList .per-row').count();
  ok(rows === 4, '记录列表 4 条，实际 ' + rows);
  await page.screenshot({ path: 'ui-经期.png', fullPage: true });

  console.log('\n[手填周期能不能改得动 —— 上次踩的坑]');
  await page.fill('#perCycle', '30');
  await page.fill('#perDays', '7');
  await page.click('#page-period button:has-text("保存")'); await page.waitForTimeout(900);
  await page.click('#page-period .sp-back'); await page.waitForTimeout(400);
  await page.click(".set-card:has-text(\"她的身体\") button"); await page.waitForTimeout(900);
  const c2 = await page.locator('#perCycle').inputValue(), d2 = await page.locator('#perDays').inputValue();
  ok(c2 === '30' && d2 === '7', '重进还是她填的 30 / 7（不是算出来的 29），实际 ' + c2 + ' / ' + d2);
  ok(/30/.test(await page.locator('#perStat').textContent()), '下次按她填的 30 天算');

  console.log('\n[改回自己算]');
  await page.fill('#perCycle', '0'); await page.fill('#perDays', '0');
  await page.click('#page-period button:has-text("保存")'); await page.waitForTimeout(900);
  ok(/29/.test(await page.locator('#perStat').textContent()), '填 0 就回到自己算的 29');

  console.log('\n[今天来了]');
  await page.click('button:has-text("今天来了")'); await page.waitForTimeout(1000);
  const now2 = await page.locator('#perNow').textContent();
  console.log('      大字：' + now2);
  ok(/第\s*1\s*天/.test(now2), '变成「第 1 天」');
  ok(await page.locator('#perList .per-row').count() === 5, '记录多了一条');

  console.log('\n[他那边看得到吗 —— 走真的工具通道]');
  const himSay = async () => await page.evaluate(async () => {
    const k = (await (await fetch('/api/mcpkey')).json()).key;
    const r = await fetch('/mcp/' + k, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_period', arguments: {} } }) });
    const j = await r.json();
    return JSON.stringify(j.result && j.result.content && j.result.content[0] ? j.result.content[0].text : j);
  });
  let him = await himSay();
  console.log('      他查到：' + him.slice(0, 60));
  ok(/第 1 天/.test(him), '开着的时候他查 check_period 看得到');

  console.log('\n[关掉「让他知道」]');
  await page.click('#perOn'); await page.waitForTimeout(900);
  const off = await page.evaluate(async () => (await (await fetch('/api/period')).json()));
  ok(off.on === false, '开关存下来了');
  him = await himSay();
  console.log('      他现在查到：' + him);
  ok(!/第 1 天|2026-0/.test(him), '他那边一个字都看不到了');
  const logged = await page.evaluate(async () => {
    const k = (await (await fetch('/api/mcpkey')).json()).key;
    const r = await fetch('/mcp/' + k, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'period_log', arguments: { what: 'end' } } }) });
    const j = await r.json();
    return (j.result && j.result.content && j.result.content[0] || {}).text || '';
  });
  console.log('      他想记一笔：' + logged);
  ok(/关上了/.test(logged), '关掉之后他也记不了');
  ok(/第\s*1\s*天/.test(await page.locator('#perNow').textContent()), '她自己还是看得到');
  await page.screenshot({ path: 'ui-经期2.png', fullPage: true });

  console.log('\n[删掉刚才那条]');
  await page.click('#perList .per-row:last-child button'); await page.waitForTimeout(900);
  ok(await page.locator('#perList .per-row').count() === 4, '删回 4 条');

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  await b.close();
})();
