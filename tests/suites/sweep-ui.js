const { chromiumPath } = require('../lib/env');
/* 界面巡检：每个标签页、每个子页都打开，页面里无害的按钮都点一下 */
const { chromium } = require('playwright-core'); const fs = require('fs');
(async () => {
  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [], cons = [], http = [];
  page.on('pageerror', e => errs.push(e.message.slice(0, 160)));
  page.on('console', m => { if (m.type() === 'error' && !/Password field|favicon|ERR_CONNECTION|Failed to load resource/.test(m.text())) cons.push(m.text().slice(0, 160)); });
  page.on('response', r => { if (r.status() >= 500) http.push(r.status() + ' ' + r.url().replace('http://localhost:8081', '')); });
  page.on('dialog', d => d.dismiss());   // 所有「确定要删吗」一律取消
  await page.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2200);

  const SUBS = await page.evaluate(() => SUBS);
  /* 会真删、真发、真改钥匙、真叫醒他的按钮，不点 */
  const DANGER = /删|清|重置|换一把|恢复|导入|寄|发|推|叫|试|封存|退出|修改密码|忘|新增|保存|开启|取消|上传|连一下|打开|结束|来了|拍|相册|文件/;
  const report = [];
  for (const tab of ['home', 'chat', 'memory', 'settings']) {
    await page.evaluate(t => document.querySelector(`.tab[data-page="${t}"]`).click(), tab);
    await page.waitForTimeout(900);
    const e0 = errs.length;
    const btns = await page.$$eval(`#page-${tab} button:not([disabled])`, (bs, re) => bs.filter(b => b.offsetParent && !new RegExp(re).test(b.textContent)).map(b => b.textContent.trim().slice(0, 12)), DANGER.source);
    report.push(`${tab.padEnd(10)} 打开 ✓  可点的无害按钮 ${btns.length} 个` + (errs.length > e0 ? '  ✗ 报错' : ''));
  }
  for (const s of SUBS) {
    const e0 = errs.length, c0 = cons.length;
    await page.evaluate(n => openSub(n), s);
    await page.waitForTimeout(700);
    const visible = await page.$eval('#page-' + s, el => el.classList.contains('open')).catch(() => false);
    /* 子页里的无害按钮（刷新、切换 tab 之类）点一遍 */
    const n = await page.evaluate(([n, re]) => {
      const bs = [...document.querySelectorAll('#page-' + n + ' button')].filter(b => b.offsetParent && !new RegExp(re).test(b.textContent) && !b.classList.contains('sp-back'));
      bs.forEach(b => { try { b.click(); } catch {} });
      return bs.length;
    }, [s, DANGER.source]);
    await page.waitForTimeout(600);
    await page.evaluate(n => closeSub(n), s);
    await page.waitForTimeout(250);
    report.push(`子页 ${s.padEnd(12)} ${visible ? '打开 ✓' : '✗ 打不开'}  点了 ${n} 个按钮` + (errs.length > e0 ? '  ✗ 报错：' + errs.slice(e0).join(' | ') : '') + (cons.length > c0 ? '  ⚠ ' + cons.slice(c0).join(' | ') : ''));
  }
  /* 聊天里长按一条消息，那个浮窗 */
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(600);
  const hasBub = await page.$('.bub.ai');
  if (hasBub) {
    const box = await hasBub.boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
    await page.waitForTimeout(400);
    report.push('长按消息浮窗 ' + ((await page.$$eval('.ms-pop.open, #msgSheet.open, .msg-sheet.open', x => x.length)) ? '出来了 ✓' : '（没找到浮窗，选择器可能不对，人工看截图）'));
    await page.screenshot({ path: 'ui-长按.png' });
    await page.keyboard.press('Escape');
  }
  /* 管理台 */
  const e0 = errs.length;
  await page.goto('http://localhost:8081/admin', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  report.push('/admin ' + (errs.length > e0 ? '✗ 报错：' + errs.slice(e0).join(' | ') : '打开 ✓'));

  console.log(report.join('\n'));
  console.log('');
  console.log((errs.length ? '  XX  ' : '  OK  ') + '页面没报错' + (errs.length ? '：\n        ' + [...new Set(errs)].join('\n        ') : ''));
  console.log((cons.length ? '  XX  ' : '  OK  ') + '控制台没报错' + (cons.length ? '：\n        ' + [...new Set(cons)].join('\n        ') : ''));
  console.log((http.length ? '  XX  ' : '  OK  ') + '接口没有 5xx' + (http.length ? '：' + [...new Set(http)].join(', ') : ''));
  await b.close();
})();
