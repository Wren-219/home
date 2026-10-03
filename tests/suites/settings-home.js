const { chromiumPath } = require('../lib/env');
/* 设置首页：分组列表，点一行进对应的子页，返回回来 */
const B = 'http://localhost:8081';
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
(async () => {
  const { chromium } = require('playwright-core');
  const br = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await br.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(1500);
  await page.click('.tab[data-page="settings"]');
  await page.waitForTimeout(1500);

  console.log('[首页只剩一张张列表]');
  const home = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('#page-settings .set-group-t')].map(x => x.textContent),
    rows: [...document.querySelectorAll('#page-settings .set-row .t')].map(x => x.textContent),
    cards: document.querySelectorAll('#page-settings .set-card').length,
    month: document.getElementById('setMonth').textContent,
  }));
  console.log('      ' + home.groups.join(' / ') + '：' + home.rows.join('、'));
  ok(home.groups.join() === '他,你,联系,这个家', '分成四组：他、你、联系、这个家');
  ok(home.rows.length === 13, '一共 ' + home.rows.length + ' 行');
  ok(home.cards === 0, '首页上不再有大卡片');
  ok(/^￥/.test(home.month), '最上面一条：这个月花了 ' + home.month);

  await page.screenshot({ path: 'ui-设置首页.png' });
  console.log('\n[每一行点进去都是对的那页，返回能回来]');
  const want = { '模型与花费': 'model', '声音': 'voice', '上网': 'search', '接进 Claude': 'connect', '外部服务': 'mcp',
    '你的时间': 'quiet', '她的身体': 'period', '手机联动': 'phone', '推送': 'push', '写信出去': 'mail',
    '备份与搬家': 'backup', '页面密码': 'pass', '连接与说明': 'about' };
  const bad = [];
  for (const [t, id] of Object.entries(want)) {
    await page.click(`#page-settings .set-row:has(.t:text-is("${t}"))`);
    await page.waitForTimeout(450);
    const open = await page.evaluate(id => document.getElementById('page-' + id).classList.contains('open'), id);
    if (!open) bad.push(t);
    await page.evaluate(id => closeSub(id), id);
    await page.waitForTimeout(350);
  }
  ok(!bad.length, '13 行都进得去、回得来' + (bad.length ? '；不对的：' + bad.join('、') : ''));

  console.log('\n[原来的功能都还在子页里]');
  const inside = await page.evaluate(() => ({
    model: !!document.querySelector('#page-model #selChat') && !!document.querySelector('#page-model #budgetCard') && !!document.querySelector('#page-model #cacheBox'),
    backup: !!document.querySelector('#page-backup #swBkAuto') && !!document.querySelector('#page-backup #bkPick'),
    push: !!document.querySelector('#page-push #pushBtn'),
    pass: !!document.querySelector('#page-pass #pwCur'),
    about: !!document.querySelector('#page-about #setHealth'),
    mcp: !!document.querySelector('#page-mcp #mcpList'),
  }));
  ok(Object.values(inside).every(Boolean), '模型 / 这个月 / 缓存、备份、推送、密码、连接说明、外部服务开关，都搬进了各自的子页：' + JSON.stringify(inside));

  console.log('\n[每一行底下的小字是当前状态]');
  const briefs = await page.evaluate(() => Object.fromEntries(['modelBrief', 'bkBrief', 'healthBrief'].map(id => [id, document.getElementById(id).textContent])));
  console.log('      ' + JSON.stringify(briefs));
  ok(/聊天/.test(briefs.modelBrief) && /已连接/.test(briefs.healthBrief) && /下载|自动/.test(briefs.bkBrief), '模型、连接、备份那几行写着现在的状态');

  console.log('\n[连接与说明里能切换屏幕底部的办法]');
  await page.evaluate(() => openSub('about'));
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => document.getElementById('swShell').classList.contains('on')), '开关亮着（默认新办法）');
  await Promise.all([page.waitForNavigation(), page.evaluate(() => shellToggle())]);
  ok(await page.evaluate(() => !document.documentElement.classList.contains('vh-shell') && localStorage.getItem('wu.shell') === 'old'), '点一下：刷新后换成老办法');
  await page.evaluate(() => localStorage.setItem('wu.shell', 'vh'));
  ok(!errs.length, '页面没报错' + (errs.length ? '：' + errs.join(' | ') : ''));
  await br.close();
})();
