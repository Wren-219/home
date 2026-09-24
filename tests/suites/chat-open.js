const { WORK, chromiumPath } = require('../lib/env');
/* 打开聊天页停在最新那条；她开着 app 的时候，他醒来说的话能冒出来 */
const { chromium } = require('playwright-core'); const fs = require('fs');
const B = 'http://localhost:8081';
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
(async () => {
  /* 先铺一段长聊天 */
  let C = '';
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');
  const put = (p, b) => fetch(B + p, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: C }, body: JSON.stringify(b) });
  const t0 = Date.now() - 3 * 3600000;
  const msgs = Array.from({ length: 80 }, (_, i) => ({ k: i % 2 ? 'ai' : 'me', t: (i % 2 ? '他' : '她') + '的第 ' + (i + 1) + ' 句', ts: t0 + i * 60000 }));
  await put('/api/state/chat', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs }] });
  await put('/api/quiet', { classes: '', on: true });

  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2000);

  console.log('[打开聊天页]');
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(500);
  const g = await page.evaluate(() => { const c = document.getElementById('chatMsgs'); return { top: c.scrollTop, h: c.scrollHeight, v: c.clientHeight }; });
  ok(g.h > g.v * 2, '聊天够长，得滚（' + g.h + ' / ' + g.v + '）');
  ok(g.h - g.top - g.v < 5, '一打开就在最底下，看到的是最新那句（离底 ' + (g.h - g.top - g.v) + 'px）');
  const seen = await page.evaluate(() => { const c = document.getElementById('chatMsgs').getBoundingClientRect();
    const last = [...document.querySelectorAll('#chatMsgs .bub')].pop().getBoundingClientRect(); return last.bottom <= c.bottom + 1 && last.top >= c.top; });
  ok(seen, '最后一个气泡整个在屏幕里');

  console.log('\n[切走再回来]');
  await page.evaluate(() => { document.getElementById('chatMsgs').scrollTop = 0; document.querySelector('.tab[data-page="home"]').click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(500);
  const g2 = await page.evaluate(() => { const c = document.getElementById('chatMsgs'); return c.scrollHeight - c.scrollTop - c.clientHeight; });
  ok(g2 < 5, '还是回到最底下');

  console.log('\n[她开着 app，他到点叫她]');
  const al = [{ id: 'k1', at: Date.now() - 1000, why: '她让我五分钟后喊她', win: 'w1', made: Date.now() - 300000, asked: true }];
  fs.writeFileSync(WORK + '/dat/alarms.json', JSON.stringify(al));
  plan(['{"say":true,"text":"五分钟到啦，起来～","again":null}']);
  const w = await (await fetch(B + '/api/wake/test', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C }, body: '{"force":false}' })).json();
  ok(w.said, '服务器那边他开口了');
  await page.evaluate(() => pullFresh());
  await page.waitForTimeout(500);
  const lastTxt = await page.evaluate(() => [...document.querySelectorAll('#chatMsgs .bub')].pop().textContent);
  ok(/五分钟到啦/.test(lastTxt), '不用重新解锁，屏幕上就冒出来了：「' + lastTxt + '」');
  const g3 = await page.evaluate(() => { const c = document.getElementById('chatMsgs'); return c.scrollHeight - c.scrollTop - c.clientHeight; });
  ok(g3 < 5, '而且停在它那儿');

  console.log('\n[她接着回一句]');
  await page.fill('#chatInput', '好啦醒了');
  plan(['嗯，早。']);
  await page.click('#sendBtn');
  await page.waitForTimeout(2500);
  const saved = JSON.parse(fs.readFileSync(WORK + '/dat/chat.json', 'utf8')).windows[0].msgs.map(m => m.t);
  ok(saved.includes('五分钟到啦，起来～') && saved.includes('好啦醒了'), '存下来的记录里两句都在');
  const n = saved.filter(t => t === '五分钟到啦，起来～').length;
  ok(n === 1, '他那句只有一份（没重复）');

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  await b.close();
})();
