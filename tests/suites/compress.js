const { WORK, chromiumPath } = require('../lib/env');
/* 前情提要：快到额度时他自己把老的八成写成提要，留两成原话；滚动着写；她能看能改能撤销。
   这组把额度设成 3000（环境变量 HISTORY_BUDGET），不用造几万字 */
const fs = require('fs'), B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const reqs = () => fs.existsSync(WORK + '/reqs.json') ? JSON.parse(fs.readFileSync(WORK + '/reqs.json', 'utf8')) : [];
const clr = () => fs.rmSync(WORK + '/reqs.json', { force: true });
const chatFile = () => JSON.parse(fs.readFileSync(WORK + '/dat/chat.json', 'utf8'));
const sums = () => { try { return JSON.parse(fs.readFileSync(WORK + '/dat/summaries.json', 'utf8')); } catch { return {}; } };
/* 学前端：她发一句 → 先存进 chat.json → 带着整个窗口（每条带时间）去问他 → 他的回话存回去 */
const apiMsgs = msgs => msgs.map(m => ({ role: m.k === 'ai' ? 'assistant' : 'user', content: m.t, ts: m.ts }));
let clock = Date.now() - 2 * 86400000;
const tick = () => (clock += 60000);
async function turn(text) {
  const c = chatFile(); const w = c.windows[0];
  w.msgs.push({ k: 'me', t: text, ts: tick() });
  await j('/api/state/chat', 'PUT', c);
  const out = await (await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
    body: JSON.stringify({ windowId: 'w1', messages: apiMsgs(w.msgs), prevTs: Date.now() - 60000 }) })).text();
  const reply = out.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map(l => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
  const c2 = chatFile(); c2.windows[0].msgs.push({ k: 'ai', t: reply, ts: tick() });
  await j('/api/state/chat', 'PUT', c2);
  return reply;
}
const chatReqs = () => reqs().filter(x => x.stream);
const sysOf = req => req.messages.filter(m => m.role === 'system').map(m => m.content);

(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');

  /* 铺 56 句（每句五十来字），两天前开始聊的 */
  const talk = i => (i % 2 ? '我' : '她') + '说的第' + i + '句：' + '今天下雨了，她在图书馆等雨停，顺手把借的那本小说看完了。'.repeat(2);
  const msgs = Array.from({ length: 56 }, (_, i) => ({ k: i % 2 ? 'ai' : 'me', t: talk(i), ts: tick() }));
  await j('/api/state/chat', 'PUT', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs }] });

  console.log('[快到额度（九成）→ 聊完这句，他在后台写前情提要]');
  clr(); plan(['嗯，在呢。', '前情提要第一版：她那两天一直在下雨的图书馆里，把借的小说看完了。我陪着她说了很多话。']);
  await turn('还在吗');
  await sleep(1500);
  let sm = sums().w1;
  ok(sm && /第一版/.test(sm.text), '写好了：「' + (sm ? sm.text.slice(0, 24) : '没有') + '…」');
  const cq = reqs().find(x => !x.stream);
  const ask = cq ? cq.messages.map(m => m.content).join('\n') : '';
  ok(cq && cq.messages[0].role === 'system' && /你是「晤」/.test(cq.messages[0].content), '是他自己写的（聊天那个模型、带着他的人设）');
  ok(/用你自己的口吻/.test(ask) && /「我」是你，「她」是她/.test(ask), '用他自己的口吻');
  ok(/她说的第0句/.test(ask) && !/还在吗/.test(ask), '交给他的是老的那一段，最近的原话留着没压');
  ok(/— \d+月\d+日 —/.test(ask), '按天标了日期，他知道那些是哪天的事');
  const all = chatFile().windows[0].msgs;
  const keptIdx = all.findIndex(m => m.ts > sm.upto);
  const keptTok = all.slice(keptIdx).reduce((n, m) => n + m.t.length + 4, 0);
  ok(keptTok >= 600 && keptTok < 1200, '留下的原话大约两成额度（' + keptTok + ' / 3000）');

  console.log('\n[下一句：他看到的是提要 + 最近的原话]');
  clr(); plan(['嗯。']);
  await turn('雨停了');
  let q = chatReqs()[0];
  const sys = sysOf(q);
  ok(sys.some(t => /^【前情提要/.test(t) && /第一版/.test(t)), '前情提要在');
  ok(!q.messages.some(m => m.role !== 'system' && /她说的第0句/.test(m.content)), '压掉的原话不再送');
  ok(q.messages.some(m => /还在吗/.test(m.content)), '最近的原话还在');
  const iSum = q.messages.findIndex(m => /^【前情提要/.test(m.content));
  ok(iSum > 0 && q.messages.slice(0, iSum).every(m => m.role === 'system') && q.messages[iSum + 1].role !== 'system', '排在人设、工具说明后面，聊天记录前面');
  ok(!q.messages.some(m => 'ts' in m), '时间只用来划线，不发给模型');
  const pre1 = q.messages.slice(0, q.messages.length - 1);

  console.log('\n[再下一句：前缀一个字都不变]');
  clr(); plan(['嗯嗯。']);
  await turn('那我回去了');
  q = chatReqs()[0];
  ok(JSON.stringify(q.messages.slice(0, pre1.length).filter(m => m.role !== 'system' || /^【前情提要|你是「晤」/.test(m.content))) ===
     JSON.stringify(pre1.filter(m => m.role !== 'system' || /^【前情提要|你是「晤」/.test(m.content))), '提要和原话都原样，缓存接得上');
  const cs = (await j('/api/cachestats')).d;
  ok(cs.turns.some(t => /前情提要更新了/.test(t.brk || '')), '缓存体检认得出「前情提要更新了」那一轮');

  console.log('\n[他醒来的时候，看到的是同一份]');
  clr(); plan(['{"say":false}']);
  await j('/api/quiet', 'PUT', { classes: '', on: true });
  await j('/api/wake/test', 'POST', { why: '想问问她到家没' });
  const wq = reqs()[0];
  const cutAt = pre1.findIndex(m => /还在吗/.test(m.content));
  ok(wq && JSON.stringify(wq.messages.slice(0, cutAt)) === JSON.stringify(pre1.slice(0, cutAt)), '唤醒请求到那段原话为止，跟聊天逐字相同');

  console.log('\n[聊着聊着又到九成 → 滚动：旧提要 + 新的一段 → 新提要]');
  for (let i = 0; i < 34; i++) {
    const c = chatFile(); c.windows[0].msgs.push({ k: i % 2 ? 'ai' : 'me', t: talk(100 + i), ts: tick() });
    await j('/api/state/chat', 'PUT', c);
  }
  clr(); plan(['嗯。', '前情提要第二版：前两天下雨，她在图书馆看完小说；后来雨停了她回了家。']);
  await turn('我到家啦');
  await sleep(1500);
  sm = sums().w1;
  ok(sm && /第二版/.test(sm.text) && sm.n === 2, '第二版写好了（压过 ' + (sm && sm.n) + ' 次）');
  const ask2 = (reqs().find(x => !x.stream) || { messages: [] }).messages.map(m => m.content).join('\n');
  ok(/【我之前写的前情提要】[\s\S]*第一版/.test(ask2) && /旧提要里的事要并进来/.test(ask2), '写第二版的时候，把第一版交给了他并进去');

  console.log('\n[她来看、改、撤销]');
  const g = (await j('/api/summary?win=w1')).d;
  ok(/第二版/.test(g.text) && g.n === 2 && g.upto > 0, '看得到');
  await j('/api/summary', 'PUT', { win: 'w1', text: '（她改过）前两天一直下雨，她在图书馆看完了《海边的卡夫卡》。' });
  clr(); plan(['嗯。']);
  await turn('你记得我看的什么书吗');
  ok(sysOf(chatReqs()[0]).some(t => /海边的卡夫卡/.test(t)), '改过的那版，他下一句就用上了');
  ok((await j('/api/summary?win=w1')).d.edited === true, '标着「你改过」');
  ok((await j('/api/summary', 'PUT', { win: 'w1', text: '' })).s === 400, '不许改成空的（要原话回来得点撤销）');

  console.log('\n[界面]');
  const { chromium } = require('playwright-core');
  const br = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await br.newContext({ viewport: { width: 393, height: 852 }, isMobile: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(800);
  const fold = await page.evaluate(() => { const f = document.querySelector('#chatMsgs .m-fold'); return f ? { t: f.textContent, next: f.nextElementSibling && f.nextElementSibling.textContent } : null; });
  ok(fold && /前情提要/.test(fold.t), '聊天里压到哪儿有一道线：「' + (fold && fold.t) + '」');
  ok(await page.evaluate(() => [...document.querySelectorAll('#winMenu .win-item')].some(x => /前情提要/.test(x.textContent))), '窗口菜单里有「前情提要」');
  await page.evaluate(() => sumOpen());
  await page.waitForTimeout(600);
  const shown = await page.evaluate(() => ({ text: document.getElementById('sumText').value, meta: document.getElementById('sumMeta').textContent }));
  ok(/海边的卡夫卡/.test(shown.text) && /压缩过 2 次/.test(shown.meta) && /你改过/.test(shown.meta), '打开看得到正文，和「压缩过 2 次 · 你改过」');
  await page.fill('#sumText', '在界面上改的：她看完了《海边的卡夫卡》，雨停了。');
  await page.evaluate(() => sumSave());
  await page.waitForTimeout(500);
  ok(/在界面上改的/.test(sums().w1.text), '在界面上改也存得上');
  await page.evaluate(() => sumOpen());
  await page.waitForTimeout(400);
  await page.evaluate(() => sumUndo());
  await page.waitForTimeout(600);
  ok(!sums().w1, '撤销了');
  ok(!(await page.evaluate(() => !!document.querySelector('#chatMsgs .m-fold'))), '那道线也没了');
  clr(); plan(['嗯。']);
  await turn('再问一句');
  const back = chatReqs()[0];
  ok(!sysOf(back).some(t => /^【前情提要/.test(t)) && back.messages.some(m => /她说的第100句/.test(m.content)), '原话放回来了（超额度的部分照旧按额度截）');
  ok(!errs.length, '页面没报错' + (errs.length ? '：' + errs.join(' | ') : ''));
  await br.close();
})();
