const { WORK, chromiumPath } = require('../lib/env');
/* 这个月花了多少：按天记账、按现在的价格算、预测、预算、花到了他就先不主动醒 */
const fs = require('fs'), B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const near = (a, b) => Math.abs(a - b) < 1e-4;   // 服务器按 4 位小数给
const say = async t => (await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
  body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: t }] }) })).text();
(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');

  console.log('[第一次开账：用量记录里还留着的也搬过来]');
  /* 装作之前已经聊过两次（今天早些时候），还没有账本 */
  const earlier = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(WORK + '/dat/usage.json', JSON.stringify({ total: {}, recent: [
    { t: earlier, api: '假模型', role: 'chat', in: 100000, out: 10000, cacheRead: 50000, cacheWrite: 0, cost: 0, unit: '￥' },
    { t: earlier, api: '假模型', role: 'chat', in: 100000, out: 10000, cacheRead: 50000, cacheWrite: 0, cost: 0, unit: '￥' } ] }));
  let b = (await j('/api/budget')).d;
  /* 假模型的价格：输入 1、输出 2、命中缓存 0.1（每百万）→ 每次 (50000×1 + 50000×0.1 + 10000×2) / 1e6 = 0.075 */
  ok(near(b.spent, 0.15), '这个月已花 ￥' + b.spent + '（两次，每次 0.075）');
  ok(b.auto && !b.over, '还没定预算，只看不管');
  ok(!b.noPrice, '现在这套填过价格');

  console.log('\n[聊一句，账上跟着加]');
  plan(['嗯。']);
  await say('在吗');
  b = (await j('/api/budget')).d;
  /* 假模型流式回 1200 入（没报命中）、30 出 → (1200×1 + 30×2)/1e6 */
  ok(near(b.spent, 0.15 + 0.00126), '加上了这一句的 ￥0.00126（没有算两遍）');
  ok(b.days.length === b.today && b.days[b.days.length - 1].cost > 0, '按天列着，今天那根有数');
  ok(b.forecast > 0, '按现在的速度，这个月大约 ￥' + b.forecast);

  console.log('\n[补填价格，这个月的账跟着重算]');
  b = (await j('/api/budget/price', 'PUT', { in: 2, out: 4, cacheRead: 0.2, unit: '￥' })).d;
  ok(near(b.spent, (0.15 + 0.00126) * 2), '价格翻倍，这个月已花也翻倍：￥' + b.spent);
  const apis = (await j('/api/apis')).d;
  ok(apis.list.find(x => x.id === 'm1').price.in === 2, '价格存在了现在聊天用的那套上');

  console.log('\n[环境变量那套也能填价格]');
  await j('/api/apis/use', 'PUT', { chat: null });
  b = (await j('/api/budget')).d;
  ok(b.api.fromEnv && b.noPrice, '换回环境变量那套：提示「还没填价格」');
  b = (await j('/api/budget/price', 'PUT', { in: 1, out: 2, cacheRead: 0.02, unit: '元' })).d;
  ok(!b.noPrice && b.api.price.in === 1, '填上了（存在 envprice.json）');
  await j('/api/apis/use', 'PUT', { chat: 'm1' });

  console.log('\n[定预算，花到了 → 他先不主动醒]');
  b = (await j('/api/budget', 'PUT', { amount: 0.01 })).d;
  ok(b.amount === 0.01 && b.over, '预算 ￥0.01，已经花到了');
  await j('/api/quiet', 'PUT', { classes: '', on: true });
  fs.writeFileSync(WORK + '/dat/drives.json', '{}');
  fs.writeFileSync(WORK + '/dat/alarms.json', JSON.stringify([{ id: 'x1', at: Date.now() - 1000, why: '想问问她午饭吃了没', win: 'w1', made: Date.now() - 3600000 }]));
  const w = (await j('/api/wake/test', 'POST', { force: false })).d;
  ok(w.skipped === '这个月的预算花到了', '他自己记的闹钟：顺延到下个月（' + w.skipped + '）');
  fs.writeFileSync(WORK + '/dat/alarms.json', JSON.stringify([{ id: 'x2', at: Date.now() - 1000, why: '她让我五分钟后喊她', win: 'w1', made: Date.now(), asked: true }]));
  plan(['{"say":true,"text":"起来啦","again":null}']);
  const w2 = (await j('/api/wake/test', 'POST', { force: false })).d;
  ok(w2.said === true, '她让他叫的，照样叫');
  plan(['嗯。']);
  ok(/嗯/.test(await say('还在吗')), '聊天照常');

  console.log('\n[设置页]');
  const { chromium } = require('playwright-core');
  const br = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await br.newContext({ viewport: { width: 393, height: 852 }, isMobile: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('.tab[data-page="settings"]').click());
  await page.waitForTimeout(1500);
  const ui = await page.evaluate(() => ({ spent: document.getElementById('budSpent').textContent, of: document.getElementById('budOf').textContent,
    over: document.getElementById('budgetCard').classList.contains('over'), bars: document.querySelectorAll('#budDays span').length,
    note: document.getElementById('budNote').textContent }));
  console.log('      ' + ui.spent + ' ' + ui.of + ' · ' + ui.note);
  ok(/^￥/.test(ui.spent) && /预算 ￥0\.010/.test(ui.of) && ui.over, '显示已花、预算、花到了（变红）');
  ok(ui.bars >= 1, '每天一根小柱子（' + ui.bars + ' 根）');
  await page.click('.bud-set .btn.ghost');
  await page.waitForTimeout(600);
  const free = (await j('/api/budget')).d;
  ok(free.auto, '点「不设」就回到只看不管');
  await page.fill('#budAmount', '');
  await page.click('.bud-set .btn:not(.ghost)');
  await page.waitForTimeout(600);
  const set = (await j('/api/budget')).d;
  ok(!set.auto && set.amount === free.budget && set.amount > free.forecast, '空着点「定下来」= 按预测定（预测 ￥' + free.forecast + '，留两成余量 → ￥' + set.amount + '）');
  await page.fill('#budAmount', '30');
  await page.click('.bud-set .btn:not(.ghost)');
  await page.waitForTimeout(600);
  ok((await j('/api/budget')).d.amount === 30, '手动填 30 就是 30');
  ok(!errs.length, '页面没报错' + (errs.length ? '：' + errs.join(' | ') : ''));
  await br.close();
})();
