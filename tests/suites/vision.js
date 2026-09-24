const { WORK, chromiumPath } = require('../lib/env');
/* 看图这条路的测试。浏览器里真选一张大图发出去，看模型那头到底收到什么 */
const { chromium } = require('playwright-core'); const fs = require('fs'), D = WORK;
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const areqs = () => fs.existsSync(D + '/areqs.json') ? JSON.parse(fs.readFileSync(D + '/areqs.json', 'utf8')) : [];
const oreqs = () => fs.existsSync(D + '/reqs.json') ? JSON.parse(fs.readFileSync(D + '/reqs.json', 'utf8')) : [];
const plan = s => fs.writeFileSync(D + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const imgMsgs = req => (req.messages || []).filter(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image' || b.type === 'image_url'));
(async () => {
  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  /* 先造一张「iPhone 原图」那么大的照片：3000×2000 */
  const pg0 = await (await b.newContext({ viewport: { width: 750, height: 500 }, deviceScaleFactor: 4 })).newPage();
  await pg0.setContent('<body style="margin:0;background:linear-gradient(135deg,#f6c,#6cf);font:bold 90px serif;display:flex;align-items:center;justify-content:center;height:100vh">柠檬塔 🍋</body>');
  const big = await pg0.screenshot({ type: 'png' });
  fs.writeFileSync(D + '/big.png', big);
  console.log('      造了一张 ' + (big.length / 1024).toFixed(0) + ' KB 的 3000×2000 原图');

  const page = await (await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2000);
  const api = (p, m, body) => page.evaluate(async ([p, m, body]) => {
    const r = await fetch(p, { method: m || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  }, [p, m, body]);

  /* 两套：假 Claude（默认看得懂图）和一个 OpenAI 格式的 */
  const cl = await api('api/apis', 'POST', { name: '假 Claude', base: 'http://localhost:8098', key: 'k', model: 'claude-opus-5', dialect: 'anthropic' });
  const oa = await api('api/apis', 'POST', { name: '假 DeepSeek', base: 'http://localhost:8099', key: 'k', model: 'deepseek-chat', dialect: 'openai' });
  await api('api/apis/use', 'PUT', { chat: cl.id });
  const list = (await api('api/apis')).list;
  ok(list.find(x => x.id === cl.id).vision === true, 'Claude 那套没特意设，默认就看得懂图');
  ok(list.find(x => x.id === oa.id).vision === false, 'OpenAI 格式那套默认关着（DeepSeek 看不了，发了会报错）');

  /* 页面开的时候还没有 API，前端当成了离线演示 —— 建完重开一次 */
  await page.reload({ waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2000);
  console.log('\n[真选一张图发出去]');
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(600);
  await page.setInputFiles('#pickPhoto', D + '/big.png');
  await page.waitForTimeout(3500);
  plan(['好看。\n\n是上次说的那家吗']);
  await page.fill('#chatInput', '你看这个');
  await page.click('#sendBtn');
  await page.waitForTimeout(3500);

  const m = await page.evaluate(() => chatLog.filter(x => x.k === 'stack').pop());
  ok(m && m.imgs.length === 1 && m.see && m.see.length === 1, '消息里存了原图和给他看的那份：' + JSON.stringify({ imgs: m && m.imgs, see: m && m.see }));
  const dims = await page.evaluate(async ([a, b]) => {
    const dim = u => new Promise(ok => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.src = u; });
    return { orig: await dim(a), see: await dim(b), seeBytes: (await (await fetch(b)).arrayBuffer()).byteLength };
  }, [m.imgs[0], m.see[0]]);
  ok(dims.orig[0] === 3000, '相册里的还是原图 ' + dims.orig.join('×'));
  ok(Math.max(...dims.see) === 1568, '给他看的那份长边缩到了 1568：' + dims.see.join('×') + '，' + (dims.seeBytes / 1024).toFixed(0) + ' KB');

  const r1 = areqs().pop();
  const im1 = imgMsgs(r1);
  ok(im1.length === 1, '模型那头收到了一条带图的消息');
  const blocks = im1[0].content;
  const img = blocks.find(x => x.type === 'image');
  ok(img && img.source.type === 'base64' && img.source.media_type === 'image/jpeg', '是 base64 的 JPEG 图块');
  ok(Buffer.from(img.source.data, 'base64').length === dims.seeBytes, '发过去的正是那份小图，不是原图（字节数对得上）');
  ok(blocks.some(x => x.type === 'text' && x.text === '（发来了1张照片）'), '后面跟着一句「（发来了1张照片）」');
  const her = r1.messages[r1.messages.length - 1];
  ok(JSON.stringify(her).includes('你看这个'), '她那句话照常跟在后面');

  console.log('\n[接着聊 —— 那张图的字节不能变，缓存才接得上]');
  plan(['嗯嗯']);
  await page.fill('#chatInput', '对呀');
  await page.click('#sendBtn');
  await page.waitForTimeout(2500);
  const r2 = areqs().pop();
  ok(JSON.stringify(imgMsgs(r2)[0]) === JSON.stringify(im1[0]), '第二轮里那条带图的消息，跟第一轮一个字节都不差');
  ok(JSON.stringify(r2.system) === JSON.stringify(r1.system) && JSON.stringify(r2.tools) === JSON.stringify(r1.tools), 'system 和 tools 也没动');

  console.log('\n[他醒过来的时候，也得看到同一张图]');
  plan(['{"say":false,"again":null}']);
  await api('api/wake/test', 'POST', { why: '她给我看了柠檬塔' });
  const r3 = areqs().pop();
  ok(JSON.stringify(imgMsgs(r3)[0]) === JSON.stringify(im1[0]), '唤醒那头拼出来的带图消息，跟聊天那头逐字相同');

  console.log('\n[关掉「看得懂图片」]');
  await api('api/apis/' + cl.id, 'PUT', { name: '假 Claude', base: 'http://localhost:8098', model: 'claude-opus-5', dialect: 'anthropic', vision: false });
  plan(['嗯']);
  await page.fill('#chatInput', '还有呢');
  await page.click('#sendBtn');
  await page.waitForTimeout(2500);
  const r4 = areqs().pop();
  ok(imgMsgs(r4).length === 0, '一张图都不发了');
  ok(JSON.stringify(r4.messages).includes('（发来了1张照片）（你这边看不到图片内容，只知道她发了）'), '他知道你发了图、但他看不到 —— 不会假装看见了');

  console.log('\n[OpenAI 格式]');
  await api('api/apis/use', 'PUT', { chat: oa.id });
  if (fs.existsSync(D + '/reqs.json')) fs.unlinkSync(D + '/reqs.json');
  plan(['嗯']);
  await page.fill('#chatInput', '1');
  await page.click('#sendBtn');
  await page.waitForTimeout(2500);
  let o = oreqs().pop();
  const plain = o.messages.find(x => typeof x.content === 'string' && x.content.includes('发来了1张照片'));
  ok(plain && /看不到/.test(plain.content), 'DeepSeek 那套（关着）：只收到一句话，没有图');
  ok(!JSON.stringify(o.messages).includes('"imgs"'), 'imgs 这个字段没漏出去（有的接口见到陌生字段就 400）');
  await api('api/apis/' + oa.id, 'PUT', { name: '假 DeepSeek', base: 'http://localhost:8099', model: 'gpt-4o', dialect: 'openai', vision: true });
  plan(['嗯']);
  await page.fill('#chatInput', '2');
  await page.click('#sendBtn');
  await page.waitForTimeout(2500);
  o = oreqs().pop();
  const withImg = o.messages.find(x => Array.isArray(x.content));
  const iu = withImg && withImg.content.find(x => x.type === 'image_url');
  ok(iu && /^data:image\/jpeg;base64,/.test(iu.image_url.url), '打开之后（比如 GPT-4o）：image_url 带着 data URL');

  console.log('\n[最多只留最近 12 张真图]');
  await api('api/apis/use', 'PUT', { chat: cl.id });
  await api('api/apis/' + cl.id, 'PUT', { name: '假 Claude', base: 'http://localhost:8098', model: 'claude-opus-5', dialect: 'anthropic', vision: true });
  const see = m.see[0];
  const msgs = [];
  for (let i = 0; i < 15; i++) { msgs.push({ role: 'user', content: '（发来了1张照片）', imgs: [see] }); msgs.push({ role: 'assistant', content: '嗯' + i }); }
  msgs.push({ role: 'user', content: '好多' });
  plan(['嗯']);
  await page.evaluate(async ms => { const r = await fetch('api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: ms }) }); await r.text(); }, msgs);
  const r5 = areqs().pop();
  const n = r5.messages.reduce((s, x) => s + (Array.isArray(x.content) ? x.content.filter(b => b.type === 'image').length : 0), 0);
  ok(n === 12, '15 张里只发了最近 12 张（实际 ' + n + '）');
  ok(!imgMsgs(r5).some((x, i, a) => false), '');
  const firstImgAt = r5.messages.findIndex(x => Array.isArray(x.content) && x.content.some(b => b.type === 'image'));
  const before = r5.messages.slice(0, firstImgAt).filter(x => JSON.stringify(x).includes('发来了1张照片')).length;
  ok(before === 3, '更早那 3 张只剩一句话（' + before + ' 条）');

  console.log('\n[乱塞的地址一律不认]');
  plan(['嗯']);
  await page.evaluate(async () => { const r = await fetch('api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x', imgs: ['/files/../../etc/passwd', 'https://evil.example/a.jpg', '/files/nope.jpg'] }] }) }); await r.text(); });
  const r6 = areqs().pop();
  ok(imgMsgs(r6).length === 0, '../ 路径、外部网址、不存在的文件，都没被当成图发出去');
  ok(!JSON.stringify(r6).includes('root:'), '更没有把服务器上别的文件读出去');

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  await b.close();
})();
