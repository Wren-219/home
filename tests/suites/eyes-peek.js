const { WORK, chromiumPath } = require('../lib/env');
/* 他的眼睛（看图模型把图读成文字）+ 偷看一眼屏幕 + 醒来做了什么 */
const fs = require('fs'), path = require('path'), B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const last = () => JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
const msgs = () => JSON.parse(fs.readFileSync(WORK + '/dat/chat.json', 'utf8')).windows[0].msgs;
const mails = () => { const d = path.join(WORK, 'smtp'); return fs.existsSync(d) ? fs.readdirSync(d).sort().map(f => fs.readFileSync(path.join(d, f), 'utf8')) : []; };
const peek = () => { try { return JSON.parse(fs.readFileSync(WORK + '/dat/peek.json', 'utf8')); } catch { return {}; } };
/* 一张最小的 JPEG */
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q==', 'base64');
const say = async (t, imgs) => { const r = await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
  body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: t, ...(imgs ? { imgs } : {}) }] }) }); return await r.text(); };

(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');
  await j('/api/state/chat', 'PUT', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [{ k: 'me', t: '在吗', ts: Date.now() - 3600000 }, { k: 'ai', t: '在的', ts: Date.now() - 3599000 }] }] });
  const tok = (await j('/api/hook')).d.token;

  console.log('[眼睛：她发一张图，看图模型读成文字，聊天模型（DS）靠它看见]');
  const up = (await j('/api/upload', 'POST', { name: 'a.jpg', data: JPG.toString('base64') })).d;
  await sleep(800);   // 上传后台描述
  ok(fs.existsSync(WORK + '/vseen.json') && JSON.parse(fs.readFileSync(WORK + '/vseen.json', 'utf8')).hasImg, '眼睛真收到了图');
  const desc = (await j('/api/apis')).d;
  ok(desc.visionReady, '眼睛（看图模型）配好了');
  plan(['嗯，看着挺好。']);
  await say('你看这个', [up.url]);
  const sent = last().messages.find(m => Array.isArray(m.content) ? m.content.some(x => /图片内容/.test(x.text || '')) : /图片内容.*露营/.test(m.content || ''));
  ok(sent, 'DS 收到的是图片的文字描述（他看不了图，但眼睛替他看了）');
  ok(!last().messages.some(m => JSON.stringify(m).includes('image_url')), '没把图片本身发给 DS（它也看不了）');

  console.log('\n[没配眼睛的话]');
  await j('/api/apis/use', 'PUT', { vision: 'none-x' });   // 指到不存在的，回落到没配的环境变量
  const up2 = (await j('/api/upload', 'POST', { name: 'b.jpg', data: JPG.toString('base64') })).d;
  await sleep(300);
  plan(['嗯。']);
  await say('再看这个', [up2.url]);
  ok(last().messages.some(m => /看不到图片内容/.test(JSON.stringify(m))), '看不了、也没眼睛 → 只告诉他「她发了图」，别让他瞎夸');
  await j('/api/apis/use', 'PUT', { vision: 'v1' });

  console.log('\n[醒来做了什么：查了手机才开口 → 消息带一行小字]');
  await j('/api/quiet', 'PUT', { classes: '', on: true, nightStart: 0, nightEnd: 0 });
  fs.writeFileSync(WORK + '/dat/drives.json', '{}');
  plan([{ tool: 'check_phone', args: {} }, '{"say":true,"text":"还没睡呀？","again":null}']);
  const w = (await j('/api/wake/test', 'POST', { why: '想她了' })).d;
  ok(w.said, '他开口了');
  const m = msgs().pop();
  ok(Array.isArray(m.trace) && m.trace.includes('看了眼你在忙什么'), '这句话上面有一行「醒来 · 看了眼你在忙什么」：' + JSON.stringify(m.trace));

  console.log('\n[偷看：没开的时候]');
  ok((await j('/api/quiet')).d.peekReady === false, '默认没开');
  plan([{ tool: 'peek_screen', args: {} }, '{"say":false}']);
  await j('/api/wake/test', 'POST', { why: '想看看她' });
  const toolOut = last().messages.filter(m => m.role === 'tool').pop();
  ok(toolOut && /还没开|看不了/.test(toolOut.content), '他想偷看，被挡下来（' + (toolOut ? toolOut.content.slice(0, 20) : '') + '）');

  console.log('\n[偷看：开好了，全流程]');
  await j('/api/mail', 'PUT', { host: 'smtp.fake', port: 465, user: 'me@fake.com', pass: 'good-pass', to: 'her@qq.com' });
  await j('/api/quiet', 'PUT', { peekOn: true, peekTo: 'her@icloud.com' });
  ok((await j('/api/quiet')).d.peekReady, '邮箱 + 眼睛 + 开关都齐了');
  const before = mails().length;
  plan([{ tool: 'peek_screen', args: {} }, '{"say":false}']);
  const w2 = (await j('/api/wake/test', 'POST', { why: '想看看她在干嘛' })).d;
  await sleep(300);
  const eml = mails().length > before ? mails().pop() : '';
  ok(/Subject:.*wupeek/i.test(eml) && /To: <her@icloud\.com>/.test(eml), '暗号邮件寄到单独填的 iCloud 邮箱，不是平时收信的 her@qq.com');
  ok(peek().pending && peek().pending.win === 'w1', '记下了「等一张截图」');
  ok(/等.*醒一下|传回来/.test((last().messages.filter(x => x.role === 'tool').pop() || {}).content || ''), '告诉他：不是立刻，传回来再看');

  fs.writeFileSync(WORK + '/vdesc.txt', '她在小红书上看一篇露营攻略，停在评论区');
  plan(['{"say":true,"text":"在看露营攻略呀，想去啦？","again":null}']);
  const sc = await fetch(B + '/api/screen?token=' + tok, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPG });
  const scj = await sc.json();
  await sleep(400);
  ok(scj.ok && /露营/.test(scj.desc), '截图传回来了，眼睛读出：' + scj.desc);
  const arr = msgs();
  const card = arr.find(x => x.k === 'peek');
  ok(card && /露营/.test(card.desc) && card.url, '聊天里留了一张「他看了一眼你的屏幕」的卡片');
  ok(arr[arr.length - 1].t === '在看露营攻略呀，想去啦？', '他看着截图说了句话');
  ok(!peek().pending, '这一笔办完了');
  ok(fs.readdirSync(WORK + '/dat/uploads').filter(f => f.startsWith('peek-')).length >= 1, '截图存在服务器上（只留最近几张）');

  console.log('\n[偷看：一天最多几次]');
  await j('/api/quiet', 'PUT', { peekMax: 1 });
  plan([{ tool: 'peek_screen', args: {} }, '{"say":false}']);
  await j('/api/wake/test', 'POST', { why: '再看看' });
  const t2 = (last().messages.filter(x => x.role === 'tool').pop() || {}).content || '';
  ok(/够多|最多/.test(t2), '今天看满了就不让看了（' + t2.slice(0, 20) + '）');

  console.log('\n[卡片进不了历史，也不会喂回给模型]');
  plan(['嗯。']);
  await say('刚才你看到啥');
  ok(!last().messages.some(m => m.role === 'peek' || JSON.stringify(m).includes('"k":"peek"')), '偷看卡片不会当成一条对话发给模型');

  console.log('\n[聊天页上看得到]');
  const { chromium } = require('playwright-core');
  const br = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await br.newContext({ viewport: { width: 393, height: 852 }, isMobile: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(800);
  const ui = await page.evaluate(() => ({
    card: (document.querySelector('#chatMsgs .peek-card') || {}).innerText || '',
    img: !!document.querySelector('#chatMsgs .peek-card img'),
    trace: [...document.querySelectorAll('#chatMsgs .m-wake')].map(x => x.textContent),
  }));
  ok(/他看了一眼你的屏幕/.test(ui.card) && /露营/.test(ui.card) && ui.img, '偷看卡片：标题、截图、他看到了什么');
  ok(ui.trace.some(t => t === '醒来 · 看了眼你在忙什么'), '他那句话上面有「' + (ui.trace[0] || '') + '」');
  await page.evaluate(() => openSub('quiet'));
  await page.waitForTimeout(800);
  const q = await page.evaluate(() => ({ on: document.getElementById('qPeek2').classList.contains('on'), url: document.getElementById('peekUrl').textContent, kw: document.getElementById('peekKwShow').textContent }));
  ok(q.on && /\/api\/screen\?token=\w+/.test(q.url) && q.kw === 'wupeek', '「你的时间」里：开关、上传地址（带钥匙）、暗号');
  ok(!errs.length, '页面没报错' + (errs.length ? '：' + errs.join(' | ') : ''));
  await br.close();
})();
