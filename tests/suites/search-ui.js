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
  const entry = page.locator('#page-settings .set-card:has-text("上网") button');
  ok(await entry.isVisible(), '设置页有「上网」入口');
  await entry.click(); await page.waitForTimeout(900);
  ok((await page.locator('#searchVendors .per-row').count()) === 3, '三家列出来了');
  ok(/还没配钥匙/.test(await page.locator('#searchStat').textContent()), '一开始说还没配');
  ok((await page.locator('#sKey').getAttribute('placeholder')) === '还没填', '钥匙框空着');
  await page.screenshot({ path: 'ui-上网.png', fullPage: true });

  console.log('\n[填 Tavily]');
  await page.click('#searchVendors .per-row:has-text("Tavily")'); await page.waitForTimeout(300);
  await page.fill('#sKey', 'tv-good');
  await page.click('#page-search .sp-act'); await page.waitForTimeout(900);
  ok(/配好了/.test(await page.locator('#searchStat').textContent()), '存好了');
  ok(/已存/.test(await page.locator('#sKey').getAttribute('placeholder')), '钥匙框变成「已存」：' + await page.locator('#sKey').getAttribute('placeholder'));
  ok((await page.locator('#sKey').inputValue()) === '', '钥匙本身没回显');

  console.log('\n[试搜一下]');
  await page.click('button:has-text("试搜一下")'); await page.waitForTimeout(1500);
  const out = await page.locator('#searchOut').textContent();
  console.log('      ' + out.split('\n').slice(0, 3).join(' / ').slice(0, 90));
  ok(/一句话答案/.test(out), '搜出东西来了');
  await page.screenshot({ path: 'ui-上网2.png', fullPage: true });

  console.log('\n[换一家 —— 点一下该立刻有反应]');
  await page.click('#searchVendors .per-row:has-text("博查")'); await page.waitForTimeout(300);
  ok(/● 博查/.test(await page.locator('#searchVendors').textContent()), '圆点跟着走了');
  await page.fill('#sKey', 'bo-good');
  await page.click('#page-search .sp-act'); await page.waitForTimeout(900);
  await page.click('button:has-text("试搜一下")'); await page.waitForTimeout(1500);
  ok(/博查一/.test(await page.locator('#searchOut').textContent()), '换过去真的生效了');

  console.log('\n[返回再进来，选的那家还在]');
  await page.click('#page-search .sp-back'); await page.waitForTimeout(400);
  ok(/已配好/.test(await page.locator('#searchBrief').textContent()), '设置页那行改口了：' + await page.locator('#searchBrief').textContent());
  await page.click('#page-settings .set-card:has-text("上网") button'); await page.waitForTimeout(900);
  ok(/● 博查/.test(await page.locator('#searchVendors').textContent()), '还是博查');

  console.log('\n[关掉]');
  await page.click('#sOn'); await page.waitForTimeout(900);
  ok(/关掉了/.test(await page.locator('#searchStat').textContent()), '状态变了：' + await page.locator('#searchStat').textContent());
  await page.click('#sOn'); await page.waitForTimeout(900);

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  await b.close();
})();
