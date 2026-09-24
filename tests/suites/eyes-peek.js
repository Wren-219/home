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
const apiMsgs = arr => arr.map(m => m.k === 'peek' ? { role: 'user', content: '（你看了一眼她的屏幕：' + (m.desc || '') + '）', ts: m.ts }
  : m.k === 'ask' ? { role: 'user', content: '（你请她拍张照片给你看' + (m.why ? '：' + m.why : '') + '）', ts: m.ts }
  : m.k === 'call' ? null : { role: m.k === 'ai' ? 'assistant' : 'user', content: m.t || '', ts: m.ts }).filter(Boolean);
const sayHist = async t => { const r = await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
  body: JSON.stringify({ windowId: 'w1', messages: [...apiMsgs(msgs()), { role: 'user', content: t, ts: Date.now() }] }) }); return await r.text(); };
const say = async (t, imgs) => { const r = await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
  body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: t, ...(imgs ? { imgs } : {}) }] }) }); return await r.text(); };

(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');
  await j('/api/state/chat', 'PUT', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [{ k: 'me', t: '在吗', ts: Date.now() - 3600000 }, { k: 'ai', t: '在的', ts: Date.now() - 3599000 }] }] });
  const tok = (await j('/api/hook')).d.token;

  console.log('[眼睛：她发一张图，看图模型读成文字，聊天模型（DS）靠它看见]');
  const up = (await j('/api/upload', 'POST', { name: 'see.jpg', data: JPG.toString('base64') })).d;
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
  const up2 = (await j('/api/upload', 'POST', { name: 'see.jpg', data: JPG.toString('base64') })).d;
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
  ok(/上限/.test(t2), '今天看满了就不让看了（' + t2.slice(0, 24) + '）');

  console.log('\n[他记得自己看过：历史里留一句固定的话]');
  const hist = () => apiMsgs(msgs());
  plan(['嗯。']);
  await sayHist('刚才你看到啥');
  const line = last().messages.find(m => /你看了一眼她的屏幕/.test(m.content || ''));
  ok(line && /露营攻略/.test(line.content), '历史里有：' + (line ? line.content : '没有'));
  const first = JSON.stringify(last().messages.slice(0, last().messages.indexOf(line) + 1));
  plan(['嗯嗯。']);
  await sayHist('那你觉得呢');
  const l2 = last().messages.find(m => /你看了一眼她的屏幕/.test(m.content || ''));
  ok(JSON.stringify(last().messages.slice(0, last().messages.indexOf(l2) + 1)) === first, '下一轮这句一个字没变，缓存接得上');
  ok(!last().messages.some(m => JSON.stringify(m).includes('/files/peek-')), '截图本身不进历史（只留这句话）');

  console.log('\n[他想看看你：发一张卡片，你点了才拍]');
  plan([{ tool: 'ask_photo', args: { why: '想看看你今天的样子' } }, '{"say":true,"text":"拍一张给我看看？","again":null}']);
  await j('/api/wake/test', 'POST', { why: '想她' });
  const ask = msgs().find(x => x.k === 'ask');
  ok(ask && ask.why === '想看看你今天的样子' && !ask.done, '聊天里出现「📷 他想看看你」的卡片，还没回应');
  plan([{ tool: 'ask_photo', args: { why: '再看一眼' } }, '{"say":false}']);
  await j('/api/wake/test', 'POST', { why: '还想看' });
  ok(/刚请过/.test((last().messages.filter(x => x.role === 'tool').pop() || {}).content || ''), '5 分钟内不会连发（只防手滑）');
  fs.rmSync(WORK + '/dat/askphoto.json', { force: true });
  plan([{ tool: 'ask_photo', args: { why: '想看看你那边天气', camera: 'around' } }, '{"say":false}']);
  await j('/api/wake/test', 'POST', { why: '想看她那边' });
  const back = msgs().filter(x => x.k === 'ask').pop();
  ok(back && back.camera === 'around', '也能请她用后置拍身边');
  plan(['嗯。']);
  await sayHist('等下拍');
  ok(last().messages.some(m => m.content === '（你请她拍张照片给你看：想看看你今天的样子）'), '历史里他记得自己请过');

  console.log('\n[聊天模型自己能看图（比如 Claude）：截图直接给他，描述他自己写]');
  const c = (await j('/api/apis', 'POST', { name: '假 Claude', base: 'http://localhost:8098', key: 'sk-a', model: 'claude-opus-5', dialect: 'anthropic', price: { in: 5, out: 25, unit: '$' } })).d;
  await j('/api/apis/use', 'PUT', { chat: c.id });
  await j('/api/quiet', 'PUT', { peekMax: 10 });
  fs.writeFileSync(WORK + '/dat/peek.json', '{}');
  fs.rmSync(WORK + '/vseen.json', { force: true });
  plan([{ tool: 'peek_screen', args: {} }, '{"say":false}']);
  await j('/api/wake/test', 'POST', { why: '想看看她' });
  ok(peek().pending, '他要看了（Claude 这边不需要眼睛也能开）');
  fs.rmSync(WORK + '/areqs.json', { force: true });
  plan(['{"say":true,"text":"又在看猫啦","saw":"她在刷一个橘猫打翻水杯的视频","again":null}']);
  const sc2 = await (await fetch(B + '/api/screen?token=' + tok, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPG })).json();
  await sleep(300);
  const areq = JSON.parse(fs.readFileSync(WORK + '/areqs.json', 'utf8')).pop();
  const lastUser = areq.messages[areq.messages.length - 1];
  ok(Array.isArray(lastUser.content) && lastUser.content.some(b => b.type === 'image'), '截图直接放进了他这一轮（他自己看）');
  ok(!fs.existsSync(WORK + '/vseen.json'), '没去找眼睛（省了一次）');
  const card2 = msgs().filter(x => x.k === 'peek').pop();
  ok(card2 && card2.desc === '她在刷一个橘猫打翻水杯的视频' && sc2.desc === card2.desc, '卡片上是他自己写的：「' + (card2 && card2.desc) + '」');
  await j('/api/apis/use', 'PUT', { chat: 'm1' });

  console.log('\n[照片张数她能自己调]');
  ok(JSON.stringify((await j('/api/imgconf')).d) === '{"max":8,"step":6}', '默认最多 8 张、超了一次换 6 张');
  ok(JSON.stringify((await j('/api/imgconf', 'PUT', { max: 30, step: 0 })).d) === '{"max":20,"step":6}', '乱填会被拉回合理范围（最多 20 张；换 0 张当没填，用默认 6）');
  await j('/api/imgconf', 'PUT', { max: 8, step: 6 });

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
  const askUi = await page.evaluate(() => { const c = document.querySelector('#chatMsgs .ask-card'); return c ? { t: c.innerText, btns: c.querySelectorAll('button').length, cam: document.getElementById('pickCam').getAttribute('capture') } : null; });
  ok(askUi && /他想看看你/.test(askUi.t) && askUi.btns === 2 && askUi.cam === 'user', '请求卡片：「拍一张」「这会儿不方便」两个按钮，拍照用前置镜头');
  const backUi = await page.evaluate(() => [...document.querySelectorAll('#chatMsgs .ask-card .pk-top')].map(x => x.textContent));
  ok(backUi.includes('📷 他想看看你身边'), '后置的卡片写着「他想看看你身边」');
  ok(await page.evaluate(() => document.getElementById('pickCamBack').getAttribute('capture')) === 'environment', '后置那张拍照用后置镜头');
  await page.evaluate(() => [...document.querySelectorAll('#chatMsgs .ask-card button')].find(b => /不方便/.test(b.textContent)).click());
  await page.waitForTimeout(800);
  ok((await page.evaluate(() => (document.querySelector('#chatMsgs .ask-card') || {}).innerText || '')).includes('这次没拍'), '点了「这会儿不方便」，卡片收起');
  await page.evaluate(() => openSub('quiet'));
  await page.waitForTimeout(800);
  const q = await page.evaluate(() => ({ on: document.getElementById('qPeek2').classList.contains('on'), url: document.getElementById('peekUrl').textContent, kw: document.getElementById('peekKwShow').textContent }));
  ok(q.on && /\/api\/screen\?token=\w+/.test(q.url) && q.kw === 'wupeek', '「你的时间」里：开关、上传地址（带钥匙）、暗号');
  ok(!errs.length, '页面没报错' + (errs.length ? '：' + errs.join(' | ') : ''));
  await br.close();
})();
