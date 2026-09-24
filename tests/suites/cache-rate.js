const { WORK, chromiumPath } = require('../lib/env');
/* 算账：像手机那样分好几块发、连着聊二十轮，缓存得一直接得上。
   接不上的那几轮，要么说得出原因（砍了一截…），要么在设置页上标红 */
const fs = require('fs'), http = require('http'), B = 'http://localhost:8081';
let C = '';
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* 手机隔着网络发一大段，是分好几块到的：随便切几刀，刀口可能正好在汉字中间 */
const postInPieces = (path, obj) => new Promise((res, rej) => {
  const buf = Buffer.from(JSON.stringify(obj));
  const cuts = [0, ...[0.23, 0.51, 0.77].map(f => Math.floor(buf.length * f) + 1), buf.length];
  const q = http.request(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C, 'Content-Length': buf.length } }, r => {
    let t = ''; r.setEncoding('utf8'); r.on('data', d => t += d); r.on('end', () => res(t));
  });
  q.on('error', rej);
  (async () => { for (let k = 0; k < cuts.length - 1; k++) { q.write(buf.subarray(cuts[k], cuts[k + 1])); await sleep(15); } q.end(); })();
});
const stats = async () => (await fetch(B + '/api/cachestats', { headers: { Cookie: C } })).json();

(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');

  console.log('[连着聊 20 轮，每轮一千来字，中间会到额度砍两次]');
  const say = '今天下课以后去了江边，风很大，看见有人在放风筝，线断了，风筝一直往对岸飘。';
  const line = (i, n) => '（' + i + '）' + say.repeat(n);
  let msgs = Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: line(i, 3) }));
  const replies = Array.from({ length: 20 }, (_, t) => '【' + t + '】' + '嗯，我在听。风筝后来找到了吗？'.repeat(30));
  plan(replies);
  for (let t = 0; t < 20; t++) {
    msgs = msgs.concat([{ role: 'user', content: '第' + t + '轮：' + say.repeat(14) }]);
    const out = await postInPieces('/api/chat', { windowId: 'w1', messages: msgs, prevTs: Date.now() - 60000 });
    const text = out.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
      .map(l => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
    msgs = msgs.concat([{ role: 'assistant', content: text }]);
  }
  let s = await stats();
  const plain = s.turns.filter(x => !x.brk);
  const cuts = s.turns.filter(x => x.brk);
  console.log('      连着聊的轮数 ' + s.turns.length + '，平均命中 ' + Math.round(s.rate * 100) + '%');
  ok(s.turns.length === 19, '第一轮之后的 19 轮都算「连着聊」');
  ok(plain.every(x => x.rate >= 0.9), '没砍的那些轮，每轮命中都在九成以上（最低 ' + Math.round(Math.min(...plain.map(x => x.rate)) * 100) + '%）');
  ok(cuts.length >= 1 && cuts.every(x => /砍了一截/.test(x.brk)), '接不上的 ' + cuts.length + ' 轮都说得出原因：' + [...new Set(cuts.map(x => x.brk))].join('、'));
  ok(cuts.length <= 3, '20 轮里只砍了 ' + cuts.length + ' 次（以前是每轮挤掉一句，轮轮都接不上）');
  ok(s.bad === 0, '没有「说不出原因的」');

  console.log('\n[服务商那边缓存没了，我们这边却什么都没变 —— 这种才标红]');
  plan([{ flush: true, text: '嗯。' }]);
  msgs = msgs.concat([{ role: 'user', content: '在吗' }]);
  await postInPieces('/api/chat', { windowId: 'w1', messages: msgs, prevTs: Date.now() - 60000 });
  s = await stats();
  ok(s.bad === 1 && s.turns[0].bad && !s.turns[0].brk, '这一轮被标出来了：命中 ' + Math.round(s.turns[0].rate * 100) + '%，原因不明');

  console.log('\n[她删了一条旧消息]');
  plan(['嗯。']);
  msgs.splice(msgs.length - 20, 2);
  msgs = msgs.concat([{ role: 'assistant', content: '嗯。' }, { role: 'user', content: '刚才删了两句' }]);
  await postInPieces('/api/chat', { windowId: 'w1', messages: msgs, prevTs: Date.now() - 60000 });
  s = await stats();
  ok(/条变了/.test(s.turns[0].brk || '') && !s.turns[0].bad, '认得出是中间的消息变了（' + s.turns[0].brk + '），不算 bug');

  console.log('\n[设置页上看得到]');
  const { chromium } = require('playwright-core');
  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('.tab[data-page="settings"]').click());
  await page.waitForTimeout(1500);
  const box = await page.evaluate(() => { const e = document.getElementById('cacheBox'); return { text: e.innerText, alarm: e.classList.contains('alarm'), shown: e.offsetHeight > 0 }; });
  console.log('      ' + box.text.split('\n').join('\n      '));
  ok(box.shown && /缓存命中 \d+%/.test(box.text), '显示了命中率');
  ok(box.alarm && /可能是 bug/.test(box.text), '那一轮说不出原因的，标红了');
  ok(/砍了一截/.test(box.text), '有原因的也列着');
  ok(!errs.length, '页面没报错' + (errs.length ? '：' + errs.join(' | ') : ''));
  await b.close();
})();
