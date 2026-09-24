const { WORK, chromiumPath } = require('../lib/env');
/* 她聊着聊着不回了，他看一眼她的手机，自己决定追不追 */
const fs = require('fs'), B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const chase = () => { try { return JSON.parse(fs.readFileSync(WORK + '/dat/chase.json', 'utf8')); } catch { return {}; } };
const setChase = o => fs.writeFileSync(WORK + '/dat/chase.json', JSON.stringify({ ...chase(), ...o }));
/* 服务器是回完话之后才记「追问」那一笔的，读之前稍等一下 */
const say = async t => { const x = await (await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
  body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: t }] }) })).text(); await new Promise(r => setTimeout(r, 300)); return x; };
const msgs = () => JSON.parse(fs.readFileSync(WORK + '/dat/chat.json', 'utf8')).windows[0].msgs;
/* 装作她 N 分钟前说完最后一句、他回完了 —— 把「追问」那笔拨到已经到点 */
const due = () => setChase({ at: Date.now() - 1000, since: Date.now() - 16 * 60000 });
const tick = async () => (await j('/api/wake/test', 'POST', { force: false })).d;
(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');
  await j('/api/quiet', 'PUT', { classes: '', on: true, nightStart: 0, nightEnd: 0 });
  fs.writeFileSync(WORK + '/dat/alarms.json', '[]');

  console.log('[他回完一句，心里记一笔]');
  plan(['嗯，然后呢？']);
  await say('我跟你说个事');
  let c = chase();
  ok(c.at && Math.abs(c.at - Date.now() - 15 * 60000) < 5000 && c.win === 'w1', '15 分钟后她还没回，就醒一下');
  plan(['嗯。']);
  await say('等等我');
  ok(chase().at > c.at, '她又开口了：划掉重记');

  console.log('\n[到点了，她在刷小红书]');
  const tok = (await j('/api/hook')).d.token;
  await j('/api/ping', 'POST', { token: tok, kind: 'open', app: '小红书' });
  fs.writeFileSync(WORK + '/dat/drives.json', JSON.stringify({ ...JSON.parse(fs.readFileSync(WORK + '/dat/drives.json', 'utf8')), lastUser: Date.now() - 16 * 60000 }));
  due();
  plan(['{"say":true,"text":"在刷小红书就不理我啦？","again":null}']);
  const w = await tick();
  ok(w.chase && w.said, '他追问了：「' + (w.text || '') + '」');
  const sent = JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
  const prompt = sent.messages[sent.messages.length - 1].content;
  const sys = sent.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  ok(/已经 1[56] 分钟没回你了/.test(prompt), '醒来那张纸条：她多久没回了');
  ok(/【她的手机】[\s\S]*小红书/.test(sys) && /看那里就知道/.test(prompt), '带着她的手机动静（看得到小红书开着）');
  ok(/别让她觉得被盯着/.test(prompt) && !/沉默是默认答案/.test(prompt), '追不追他自己定，但别像查岗');
  ok(msgs().pop().t === '在刷小红书就不理我啦？', '她那边收到了');
  ok(((await j('/api/alarms')).d.today.said || 0) === 0, '不占他一天主动开口的名额');
  ok(!chase().at && chase().n === 1, '一次不回只追一回（划掉了，今天追了 1 次）');
  ok((await tick()).chase !== true, '再过一分钟也不会再追');

  console.log('\n[不该追的时候]');
  const p = new Date(Date.now() + 8 * 3600000);
  const dow = '日一二三四五六'[p.getUTCDay()], hh = String(p.getUTCHours()).padStart(2, '0');
  await j('/api/quiet', 'PUT', { classes: '周' + dow + ' ' + hh + ':00-' + hh + ':59 高等数学' });
  due();
  ok((await tick()).skipped === '她在上高等数学', '她在上课 → 不追');
  await j('/api/quiet', 'PUT', { classes: '' });
  due(); setChase({ n: 4 });
  ok((await tick()).skipped === '今天追问够多了', '一天追满 4 次就不追了');
  setChase({ n: 0 });
  await j('/api/quiet', 'PUT', { chaseOn: false });
  plan(['嗯。']); await say('关掉以后');
  ok(!chase().at, '关掉以后，他回完话也不记这一笔');
  await j('/api/quiet', 'PUT', { chaseOn: true, chaseMin: 30 });
  plan(['嗯。']); await say('改成 30 分钟');
  ok(Math.abs(chase().at - Date.now() - 30 * 60000) < 5000, '改成 30 分钟就是 30 分钟');

  console.log('\n[设置页]');
  const { chromium } = require('playwright-core');
  const br = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await br.newContext({ viewport: { width: 393, height: 852 }, isMobile: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { openSub('quiet'); quietRefresh(); });
  await page.waitForTimeout(800);
  const ui = await page.evaluate(() => ({ on: document.getElementById('qChase').classList.contains('on'), min: document.getElementById('qChaseMin').value }));
  ok(ui.on && ui.min === '30', '「你的时间」里有追问的开关和分钟数（' + ui.min + '）');
  await page.evaluate(() => chaseToggle());
  await page.waitForTimeout(600);
  ok((await j('/api/quiet')).d.chaseOn === false, '点一下就关了');
  ok(!errs.length, '页面没报错' + (errs.length ? '：' + errs.join(' | ') : ''));
  await br.close();
})();
