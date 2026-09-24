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

  await page.evaluate(() => document.querySelector('.tab[data-page=\"chat\"]').click()); await page.waitForTimeout(800);
  console.log('[跟他说句话，看他想的时候什么样]');
  await page.fill('#chatInput', '在吗');
  await page.click('#sendBtn');
  await page.waitForTimeout(900);   // 正在想的时候截一张
  const live = page.locator('.think').first();
  ok(await live.isVisible(), '想的时候那一块出来了');
  ok(await live.evaluate(e => e.classList.contains('open')), '而且是摊开的 —— 能实时看他在想什么');
  const head1 = await live.locator('.lb').textContent();
  ok(/他在想/.test(head1), '标题是「' + head1 + '」');
  const partial = await live.locator('.think-body').textContent();
  ok(partial.length > 5 && partial.length < 200, '想法是一点点流出来的（这会儿 ' + partial.length + ' 字）');
  await page.screenshot({ path: 'ui-思考中.png', fullPage: false });

  console.log('\n[正文一开口，它该自己收起来]');
  await page.waitForTimeout(4500);
  ok(!(await live.evaluate(e => e.classList.contains('open'))), '卷起来了');
  const head2 = await live.locator('.lb').textContent();
  ok(/想了 \d+ 秒/.test(head2), '只剩一行「' + head2 + '」');
  const bubs = await page.evaluate(() => ({
    dom: document.querySelectorAll('#chatMsgs .bub.ai').length,
    log: chatLog.filter(x => x.k === 'ai').length,
    texts: [...document.querySelectorAll('#chatMsgs .bub.ai')].map(e => e.textContent.slice(0, 8)),
  }));
  console.log('      气泡 ' + bubs.dom + ' 个 / 记录 ' + bubs.log + ' 条：' + JSON.stringify(bubs.texts));
  ok(bubs.dom === bubs.log, '页面上的气泡数和存下来的条数对得上');

  console.log('\n[点一下能不能重新摊开]');
  await live.locator('.think-head').click();
  await page.waitForTimeout(300);
  ok(await live.evaluate(e => e.classList.contains('open')), '点开了');
  const full = await live.locator('.think-body').textContent();
  ok(/实验课/.test(full), '整段想法都在：' + full.slice(0, 26) + '…');
  await page.screenshot({ path: 'ui-思考展开.png', fullPage: false });
  await live.locator('.think-head').click(); await page.waitForTimeout(300);
  ok(!(await live.evaluate(e => e.classList.contains('open'))), '再点一下又收回去');

  console.log('\n[这段绝不能被当成对话喂回给他]');
  const sent = await page.evaluate(() => JSON.stringify(toApiMessages()));
  ok(!/实验课/.test(sent), '送给模型的消息里没有这段想法');
  const stored = await page.evaluate(() => {
    const m = chatLog.filter(x => x.k === 'ai').pop();
    const first = chatLog.filter(x => x.k === 'ai' && x.r)[0];
    return { withR: chatLog.filter(x => x.r).length, rs: first && first.rs, tail: m && m.t };
  });
  ok(stored.withR === 1, '只有第一个气泡带着这段想法（带的条数：' + stored.withR + '）');
  ok(stored.rs >= 1, '秒数也存下来了：' + stored.rs);

  console.log('\n[刷新之后还在不在]');
  await page.reload({ waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2500);
  await page.evaluate(() => document.querySelector('.tab[data-page=\"chat\"]').click()); await page.waitForTimeout(800);
  const after = page.locator('.think').first();
  ok(await after.isVisible(), '刷新后那一块还在');
  ok(/想了 \d+ 秒/.test(await after.locator('.lb').textContent()), '还是收着的一行');
  await after.locator('.think-head').click(); await page.waitForTimeout(300);
  ok(/实验课/.test(await after.locator('.think-body').textContent()), '点开内容也没丢');

  console.log('\n[设置里关掉]');
  await page.evaluate(() => { SUBS.forEach(x => closeSub(x, true)); document.querySelector('.tab[data-page=\"settings\"]').click(); }); await page.waitForTimeout(600);
  const sw = page.locator('#swThink');
  ok(await sw.evaluate(e => e.classList.contains('on')), '默认是开着的');
  await page.evaluate(() => document.getElementById('swThink').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  await sw.click(); await page.waitForTimeout(500);
  ok(!(await sw.evaluate(e => e.classList.contains('on'))), '关掉了');
  await page.evaluate(() => document.querySelector('.tab[data-page=\"chat\"]').click()); await page.waitForTimeout(800);
  ok((await page.locator('.think').count()) === 0, '聊天里那一块彻底没了');
  await page.evaluate(() => document.querySelector('.tab[data-page=\"settings\"]').click()); await page.waitForTimeout(700);
  await page.evaluate(() => document.getElementById('swThink').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  await page.locator('#swThink').click(); await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('.tab[data-page=\"chat\"]').click()); await page.waitForTimeout(800);
  ok((await page.locator('.think').count()) === 1, '开回来又有了');

  console.log('\n[不会思考的模型别凭空长出一块]');
  await page.fill('#chatInput', '嗯嗯');
  await page.click('#sendBtn');
  await page.waitForTimeout(3000);
  ok((await page.locator('.think').count()) === 1, '这轮没有想法，就没多出来（还是 1 块）');

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  await b.close();
})();
