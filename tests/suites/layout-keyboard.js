const { chromiumPath } = require('../lib/env');
/* 布局：底下那条断开的带子、键盘顶起导航栏。
   模拟一台有毛病的 iPhone：屏幕 440×956，主屏幕模式下窗口却只有 887 高 */
const { chromium } = require('playwright-core'); const fs = require('fs');
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
(async () => {
  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 440, height: 887 }, screen: { width: 440, height: 956 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  /* 真 iPhone 的屏幕尺寸不会变；Playwright 改窗口大小时会顺手改掉它，这里钉死 */
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    Object.defineProperty(Screen.prototype, 'height', { get: () => 956 });
    Object.defineProperty(Screen.prototype, 'width', { get: () => 440 });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2000);
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(600);

  console.log('[底下那条带子]');
  const g = await page.evaluate(() => ({
    body: document.body.getBoundingClientRect().height,
    frame: document.getElementById('frame').getBoundingClientRect().bottom,
    tab: document.getElementById('tabbar').getBoundingClientRect().bottom,
    appH: getComputedStyle(document.documentElement).getPropertyValue('--appH').trim(),
  }));
  console.log('      ' + JSON.stringify(g));
  ok(g.body === 956, '页面铺满了整块屏幕（956），不再停在 887');
  ok(g.frame === 956, '背景一直画到屏幕最底下');
  ok(g.tab > 887 && g.tab < 956, '导航栏落在该在的位置（离屏幕底 ' + (956 - g.tab) + 'px，靠着 home 条）');

  console.log('\n[打字的时候]');
  await page.focus('#chatInput');
  await page.waitForTimeout(200);
  /* 学 iOS 的样子：键盘一弹，窗口高度和可视高度一起缩（resizes-content） */
  await page.setViewportSize({ width: 440, height: 520 });
  await page.waitForTimeout(400);
  const k = await page.evaluate(() => ({
    kb: document.body.classList.contains('kb-open'),
    tab: getComputedStyle(document.getElementById('tabbar')).display,
    body: document.body.getBoundingClientRect().height,
    inBottom: document.querySelector('.chat-in').getBoundingClientRect().bottom,
  }));
  console.log('      ' + JSON.stringify(k));
  ok(k.kb, '窗口缩了之后，还认得出键盘开着（以前这里会被撤掉）');
  ok(k.tab === 'none', '导航栏藏起来了，不会被顶到键盘上面');
  ok(k.body === 520, '这时候页面跟着键盘缩，不去撑满屏幕');
  ok(k.inBottom <= 520 && k.inBottom > 480, '输入框贴着键盘（底边 ' + Math.round(k.inBottom) + '）');
  await page.screenshot({ path: 'ui-键盘.png' });

  console.log('\n[键盘开着的时候点发送 —— 今天差点弄坏的地方]');
  const before = await page.evaluate(() => chatLog.length);
  for (let i = 0; i < 5; i++) {
    await page.fill('#chatInput', '第' + (i + 1) + '句');
    /* 学手指：按下去停 150ms 再抬起（真人一下差不多就这么久，比那 120ms 长） */
    const bb = await page.locator('#sendBtn').boundingBox();
    const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up();
    await page.waitForTimeout(250);
  }
  const after = await page.evaluate(() => ({ n: chatLog.filter(m => m.k === 'me').length, kb: document.body.classList.contains('kb-open'),
    active: document.activeElement && document.activeElement.id, texts: chatLog.filter(m => m.k === 'me').slice(-5).map(m => m.t) }));
  ok(after.texts.join() === '第1句,第2句,第3句,第4句,第5句', '连点 5 次发送，5 句都发出去了：' + after.texts.join(' / '));
  ok(after.active === 'chatInput' && after.kb, '发完焦点还在输入框、键盘还开着（跟微信一样能接着打）');
  await page.tap('#chatInput');
  await page.fill('#chatInput', '用手指点的');
  await page.tap('#sendBtn');
  await page.waitForTimeout(300);
  ok((await page.evaluate(() => chatLog.filter(m => m.k === 'me').pop().t)) === '用手指点的', '触摸点击也发得出去');

  console.log('\n[收起键盘]');
  await page.evaluate(() => document.activeElement.blur());
  await page.setViewportSize({ width: 440, height: 887 });
  await page.waitForTimeout(500);
  const c = await page.evaluate(() => ({
    kb: document.body.classList.contains('kb-open'),
    tab: getComputedStyle(document.getElementById('tabbar')).display,
    body: document.body.getBoundingClientRect().height,
  }));
  ok(!c.kb && c.tab !== 'none', '导航栏回来了');
  ok(c.body === 956, '又铺满整块屏幕');
  await page.screenshot({ path: 'ui-底部.png' });

  console.log('\n[设置页里的输入框也一样]');
  await page.evaluate(() => document.querySelector('.tab[data-page="settings"]').click());
  await page.waitForTimeout(700);
  await page.evaluate(() => openSub('search'));
  await page.waitForTimeout(500);
  await page.focus('#sKey');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.body.classList.contains('kb-open')), '在密码框里打字也算');
  await page.evaluate(() => { document.activeElement.blur(); closeSub('search'); });
  await page.waitForTimeout(300);

  console.log('\n[没毛病的设备上，什么都不改]');
  const ctx2 = await b.newContext({ viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 }, isMobile: true });
  await ctx2.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const p2 = await ctx2.newPage();
  await p2.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  ok((await p2.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--appH').trim())) === '100%', '窗口本来就等于屏幕高：不动');
  const ctx3 = await b.newContext({ viewport: { width: 440, height: 887 }, screen: { width: 440, height: 956 }, isMobile: true });
  const p3 = await ctx3.newPage();
  await p3.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  ok((await p3.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--appH').trim())) === '100%', 'Safari 里直接开（不是主屏幕模式）：也不动，那里的底下是浏览器工具栏');

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  await b.close();
})();
