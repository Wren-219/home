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

  console.log('[新外壳（默认）：整条高度链统一 100vh]');
  const g = await page.evaluate(() => {
    const cs = el => getComputedStyle(el);
    return {
      shell: document.documentElement.classList.contains('vh-shell'),
      gap: document.documentElement.classList.contains('ios-gap'),
      html: Math.round(document.documentElement.getBoundingClientRect().height),
      body: Math.round(document.body.getBoundingClientRect().height),
      frame: Math.round(document.getElementById('frame').getBoundingClientRect().height),
      vh: Math.round(innerHeight),
      bodyPos: cs(document.body).position, htmlOv: cs(document.documentElement).overflow,
      tab: Math.round(document.getElementById('tabbar').getBoundingClientRect().bottom),
    };
  });
  console.log('      ' + JSON.stringify(g));
  ok(g.shell && !g.gap, '默认用新办法，不再靠脚本去认那条带子');
  ok(g.html === g.vh && g.body === g.vh && g.frame === g.vh, 'html / body / 外壳一样高，都是 100vh（' + g.vh + '）');
  ok(g.bodyPos !== 'fixed' && g.htmlOv === 'hidden', 'body 不再是 fixed，整页 overflow:hidden');
  ok(g.tab <= g.vh && g.vh - g.tab <= 40, '导航栏在屏幕里，贴着底（离底 ' + (g.vh - g.tab) + 'px）');

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
  ok(k.body === 520, '这时候页面跟着键盘缩（键盘开着回到「跟着窗口走」，100vh 不会跟着键盘变矮）');
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

  console.log('\n[回车就是换行，不发送]');
  const n0 = await page.evaluate(() => chatLog.filter(m => m.k === 'me').length);
  await page.fill('#chatInput', '第一行');
  await page.press('#chatInput', 'Enter');
  await page.type('#chatInput', '第二行');
  const v = await page.evaluate(() => chatInput.value);
  ok(v === '第一行\n第二行' && (await page.evaluate(() => chatLog.filter(m => m.k === 'me').length)) === n0, '按回车换了行，没有发出去：' + JSON.stringify(v));

  console.log('\n[输入栏变高，最下面那条不被盖住]');
  for (let i = 0; i < 4; i++) { await page.press('#chatInput', 'Enter'); await page.type('#chatInput', '再一行'); }
  await page.waitForTimeout(300);
  const cover = await page.evaluate(() => {
    const bubs = [...document.querySelectorAll('#chatMsgs .bub')];
    const lastB = bubs[bubs.length - 1].getBoundingClientRect();
    const bar = document.getElementById('chatIn').getBoundingClientRect();
    const c = document.getElementById('chatMsgs');
    return { lastBottom: Math.round(lastB.bottom), barTop: Math.round(bar.top), barH: Math.round(bar.height), atBottom: c.scrollHeight - c.scrollTop - c.clientHeight < 2 };
  });
  ok(cover.barH > 120 && cover.lastBottom <= cover.barTop && cover.atBottom,
    '输入栏长到 ' + cover.barH + 'px，最后一条（底边 ' + cover.lastBottom + '）还在输入栏（顶边 ' + cover.barTop + '）上面，也滚得到底');
  await page.fill('#chatInput', '');
  await page.evaluate(() => { chatInput.style.height = 'auto'; });

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
  ok(c.body === 887 && await page.evaluate(() => document.documentElement.classList.contains('vh-shell') && !document.documentElement.classList.contains('kb')), '收起键盘后回到 100vh');
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

  console.log('\n[老办法还留着：网址加 ?shell=old 就切回去]');
  const ctxO = await b.newContext({ viewport: { width: 440, height: 887 }, screen: { width: 440, height: 956 }, isMobile: true });
  await ctxO.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    Object.defineProperty(Screen.prototype, 'height', { get: () => 956 });
    Object.defineProperty(Screen.prototype, 'width', { get: () => 440 });
  });
  const po = await ctxO.newPage();
  await po.goto('http://localhost:8081/?shell=old', { waitUntil: 'networkidle' });
  const old = await po.evaluate(() => ({ shell: document.documentElement.classList.contains('vh-shell'), gap: document.documentElement.classList.contains('ios-gap'), saved: localStorage.getItem('wu.shell') }));
  ok(!old.shell && old.gap && old.saved === 'old', '老办法：认出那条带子，而且记住了（下次打开还是老办法）');
  await po.goto('http://localhost:8081/', { waitUntil: 'networkidle' });
  ok(!(await po.evaluate(() => document.documentElement.classList.contains('vh-shell'))), '不带参数再打开，还是老办法');
  await po.goto('http://localhost:8081/?shell=vh', { waitUntil: 'networkidle' });
  ok(await po.evaluate(() => document.documentElement.classList.contains('vh-shell')), '?shell=vh 切回新办法');

  console.log('\n[没毛病的设备上，什么都不改]');
  const ctx2 = await b.newContext({ viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 }, isMobile: true });
  await ctx2.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const p2 = await ctx2.newPage();
  await p2.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  ok(!(await p2.evaluate(() => document.documentElement.classList.contains('ios-gap'))), '窗口本来就等于屏幕高：不动');
  const ctx3 = await b.newContext({ viewport: { width: 440, height: 887 }, screen: { width: 440, height: 956 }, isMobile: true });
  const p3 = await ctx3.newPage();
  await p3.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  ok(!(await p3.evaluate(() => document.documentElement.classList.contains('ios-gap'))), 'Safari 里直接开（不是主屏幕模式）：也不动，那里的底下是浏览器工具栏');

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  await b.close();
})();
