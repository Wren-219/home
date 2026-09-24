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

  console.log('[没进过「她的身体」就直接开日历 —— 也得标上]');
  await page.evaluate(() => { openSub('calendar'); });
  await page.waitForTimeout(1200);
  const marked = async () => await page.evaluate(() => {
    const out = { per: [], g: [] };
    document.querySelectorAll('#calGrid .cal-cell').forEach(c => {
      if (c.classList.contains('per')) out.per.push(c.dataset.key);
      else if (c.classList.contains('per-g')) out.g.push(c.dataset.key);
    });
    return out;
  });
  await page.evaluate(() => { calY = 2026; calM = 8; renderCal(); });
  await page.waitForTimeout(600);
  let m = await marked();
  console.log('      九月实心：' + m.per.join(' '));
  console.log('      九月虚线：' + m.g.join(' '));
  ok(m.per.join() === '2026-09-01,2026-09-02,2026-09-03,2026-09-04', '8/31 那次的尾巴（9/1–9/4）标实了');
  ok(m.g.length && m.g[0] === '2026-09-29', '9/29 起是估的（上次 8/31 + 29 天）');
  ok(m.g.length === 2, '九月只露出估的头两天，其余在十月：' + m.g.join(' '));
  await page.screenshot({ path: 'ui-日历经期.png', fullPage: true });
  ok(await page.locator('#calPerLegend').isVisible(), '图例出来了');

  console.log('\n[翻到八月]');
  await page.evaluate(() => { calY = 2026; calM = 7; renderCal(); });
  await page.waitForTimeout(400);
  m = await marked();
  ok(m.per.includes('2026-08-02') && m.per.includes('2026-08-06') && m.per.includes('2026-08-31'), '八月两次都在：' + m.per.join(' '));
  ok(!m.per.includes('2026-08-07'), '8/7 没被多标（那次是 8/2→8/6）');

  console.log('\n[翻到十月 —— 全是估的]');
  await page.evaluate(() => { calY = 2026; calM = 9; renderCal(); });
  await page.waitForTimeout(400);
  m = await marked();
  ok(m.per.length === 0 && m.g.length > 0, '十月没有实的，只有估的：' + m.g.join(' '));

  console.log('\n[在「她的身体」里记一笔，日历该跟着变]');
  await page.evaluate(() => closeSub('calendar'));
  await page.click('.tab[data-page="settings"]'); await page.waitForTimeout(700);
  await page.click('#page-settings .set-card:has-text("她的身体") button'); await page.waitForTimeout(900);
  await page.click('button:has-text("今天来了")'); await page.waitForTimeout(1200);
  await page.click('#page-period .sp-back'); await page.waitForTimeout(400);
  await page.evaluate(() => { openSub('calendar'); calY = 2026; calM = 8; renderCal(); });
  await page.waitForTimeout(900);
  m = await marked();
  const todayKey = await page.evaluate(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); });
  ok(m.per.includes(todayKey), '今天（' + todayKey + '）立刻标上了');

  console.log('\n[一条都没有的时候别瞎标]');
  await page.evaluate(async () => {
    await fetch('api/period', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ list: [] }) });
    perCur = null; perDaysMap = null; renderCal();
  });
  await page.waitForTimeout(900);
  m = await marked();
  ok(m.per.length === 0 && m.g.length === 0, '干干净净');
  ok(!(await page.locator('#calPerLegend').isVisible()), '图例也收起来了');

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  await b.close();
})();
