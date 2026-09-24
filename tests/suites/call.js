/* 声音（二）：语音通话。她打给他、他打给她、挂断、未接、他醒着打过来；
   还有通话记录在他那边长什么样、通话时的缓存前缀跟聊天是不是一样 */
const { WORK, DAT, chromiumPath } = require('../lib/env');
const { chromium } = require('playwright-core'); const fs = require('fs');
const fakeMic = require('../lib/fake-mic');
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const eleven = () => fs.existsSync(WORK + '/eleven.json') ? JSON.parse(fs.readFileSync(WORK + '/eleven.json', 'utf8')) : [];
const last = () => JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
(async () => {
  const mic = fakeMic(WORK + '/mic.wav');
  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + mic, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 } });
  await ctx.grantPermissions(['microphone'], { origin: 'http://localhost:8081' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  const login = async () => {
    await page.goto('http://localhost:8081', { waitUntil: 'networkidle' });
    for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
    await page.waitForTimeout(2000);
  };
  const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn)) return true; await page.waitForTimeout(150); } return false; };
  const api = (p, m, body) => page.evaluate(async ([p, m, body]) => (await fetch(p, { method: m || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json(), [p, m, body]);
  await login();
  await api('api/voice', 'PUT', { key: 'el-good', voiceId: 'wu-voice-id' });
  await page.reload({ waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2000);
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(500);

  /* 先正常聊一句，留一份聊天的请求，待会儿跟通话的请求比前缀 */
  plan(['在的。']);
  await page.fill('#chatInput', '在吗'); await page.click('#sendBtn'); await page.waitForTimeout(2500);
  const chatReq = last();

  console.log('[她打给他]');
  fs.writeFileSync(WORK + '/stt.txt', '今天好累呀');
  plan(['喂？怎么啦', '那就早点歇着吧，今天辛苦你了。我陪你说会儿话，好不好呀，想听你说说。', '嗯嗯。', '好。']);
  await page.click('#callBtn');
  ok(await waitFor(() => document.getElementById('callView').classList.contains('on'), 3000), '通话界面出来了');
  const callReq = await (async () => { await waitFor(() => callSt && callSt.card.turns.length >= 1, 8000); return last(); })();
  ok(await page.evaluate(() => callSt.card.turns[0].k === 'ai' && callSt.card.turns[0].t === '喂？怎么啦'), '他接起来先说了一句：喂？怎么啦');
  const firstUser = callReq.messages.filter(m => m.role === 'user').pop();
  ok(/她给你打来语音电话，你接起来了/.test(JSON.stringify(firstUser)), '他知道是她打过来、他刚接起来');
  ok(/【正在打电话】/.test(JSON.stringify(callReq.messages)), '他知道现在在打电话（念出来、括号念不了、听写可能有错字）');
  ok(JSON.stringify(callReq.tools) === JSON.stringify(chatReq.tools), '通话请求的工具清单跟聊天逐字一样（缓存接得上）');
  ok(JSON.stringify(callReq.messages.slice(0, 2)) === JSON.stringify(chatReq.messages.slice(0, 2)), '人设和工具说明也逐字一样');

  ok(await waitFor(() => callSt && callSt.phase === 'listen', 10000), '他说完了，开始听她说');
  ok(await waitFor(() => callSt && callSt.card.turns.some(t => t.k === 'me'), 15000), '她说完停下来，自动听出来说完了');
  ok(await page.evaluate(() => callSt.card.turns.find(t => t.k === 'me').t === '今天好累呀'), '听写成「今天好累呀」交给了他');
  ok(await waitFor(() => callSt && callSt.card.turns.filter(t => t.k === 'ai').length >= 2, 10000), '他接着回了话');
  const tts = eleven().filter(x => x.text);
  const callTts = tts.filter(x => x.model === 'eleven_flash_v2_5');
  ok(callTts.length >= 3, '电话里用的是最快的 flash 模型（' + callTts.length + ' 段）');
  ok(callTts.every(x => x.format === 'mp3_44100_128'), '码率跟语音消息一样是 128k（以前 32k，外放发糙）');
  const p1 = callTts.find(x => x.text === '那就早点歇着吧，今天辛苦你了。'), p2 = callTts.find(x => x.text === '我陪你说会儿话，好不好呀，想听你说说。');
  ok(p1 && p2 && p1.next === p2.text && p2.prev === p1.text, '分句念的时候带着前后文，句与句之间音量语气接得上');
  ok(await page.evaluate(() => document.getElementById('cvSub').textContent.includes('今天好累呀')), '通话界面上有字幕');
  ok(/\d\d:\d\d/.test(await page.textContent('#cvSt')), '有通话计时：' + await page.textContent('#cvSt'));

  console.log('\n[他说话的时候点一下打断]');
  await waitFor(() => callSt && callSt.phase === 'talk', 12000);
  const wasTalk = await page.evaluate(() => callSt && callSt.phase);
  if (wasTalk === 'talk') {
    await page.click('#cvSub');
    ok(await waitFor(() => callSt && callSt.phase === 'listen', 2000), '点一下就不说了，直接开始听');
  } else ok(true, '（这一轮他说得太快，没赶上打断 —— 跳过）');

  console.log('\n[挂断]');
  await page.click('.cv-btn.end');
  await page.waitForTimeout(600);
  const card = await page.evaluate(() => chatLog.filter(m => m.k === 'call').pop());
  ok(card.state === 'ended' && card.dur >= 1, '通话结束，记下了时长 ' + card.dur + ' 秒');
  ok(!(await page.evaluate(() => document.getElementById('callView').classList.contains('on'))), '通话界面收起来了');
  ok(await page.evaluate(() => !micStream), '麦克风关了');
  ok(/语音通话 \d\d:\d\d/.test(await page.textContent('.call-card')), '聊天里留了一张「语音通话」卡片');
  await page.click('.call-card');
  ok((await page.textContent('.call-log.open')).includes('今天好累呀'), '点开能看到通话全文');
  const lines = await page.evaluate(() => toApiMessages().map(m => m.content));
  const i0 = lines.indexOf('（语音通话 · 她打给你的）');
  ok(i0 >= 0 && lines.includes('今天好累呀') && /^（通话结束，\d+秒）$/.test(lines[lines.length - 1]), '他那边记得这通电话：开头、内容、「通话结束」都在');

  console.log('\n[他醒过来的时候，看到的记录跟聊天时一字不差]');
  await page.waitForTimeout(1500);   /* 等聊天记录同步到服务器 */
  plan(['{"say":false}']);
  await api('api/wake/test', 'POST', { why: '想想她' });
  const wake = last().messages.filter(m => m.role !== 'system');
  wake.pop();                         /* 最后那条是唤醒提示 */
  const clientMsgs = await page.evaluate(() => toApiMessages());
  const strip = arr => arr.map(m => m.role + ':' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  const A = strip(wake), B = strip(clientMsgs).slice(-A.length);
  ok(JSON.stringify(A) === JSON.stringify(B), '服务器从存档拼出来的通话记录，跟前端拼的逐字相同（' + A.length + ' 条）');
  if (JSON.stringify(A) !== JSON.stringify(B)) { A.forEach((x, i) => { if (x !== B[i]) console.log('        不同 #' + i + '\n          服务器: ' + x + '\n          前端  : ' + B[i]); }); }

  console.log('\n[他打给她 —— 她挂掉]');
  plan([{ tool: 'call_her', args: { why: '想听你声音' } }, '等你接呀']);
  await page.fill('#chatInput', '好无聊'); await page.click('#sendBtn');
  ok(await waitFor(() => document.getElementById('callView').classList.contains('on'), 8000), '来电界面弹出来了');
  ok((await page.textContent('#cvSt')).includes('邀请你语音通话'), '「邀请你语音通话」');
  ok(!(await page.textContent('#callView')).includes('想听你声音'), '他打电话的理由她看不到');
  await page.click('.cv-btn.end');
  await page.waitForTimeout(500);
  const c2 = await page.evaluate(() => chatLog.filter(m => m.k === 'call').pop());
  ok(c2.who === 'ai' && c2.state === 'declined', '记成「她挂掉了」');
  ok((await page.evaluate(() => toApiMessages().map(m => m.content))).includes('（你给她打了个语音电话，她挂掉了）'), '他知道她挂了');

  console.log('\n[他再打 —— 她接了]');
  plan([{ tool: 'call_her', args: {} }, '', '接通啦～']);
  await page.fill('#chatInput', '刚刚在忙'); await page.click('#sendBtn');
  await waitFor(() => document.getElementById('callView').classList.contains('on'), 8000);
  await page.click('.cv-btn.ok');
  ok(await waitFor(() => callSt && (callSt.card.turns || []).some(t => t.t === '接通啦～'), 8000), '接起来他先开口：接通啦～');
  ok(/你打给她的电话，她接起来了/.test(JSON.stringify(last().messages.filter(m => m.role === 'user').pop())), '他知道是他打的、她接了');
  await page.click('.cv-btn.end');
  await page.waitForTimeout(500);
  ok((await page.evaluate(() => toApiMessages().map(m => m.content))).includes('（语音通话 · 你打给她的，她接了）'), '记录里写的是「你打给她的，她接了」');

  console.log('\n[未接来电]');
  await page.evaluate(() => { chatLog.push({ k: 'call', who: 'ai', state: 'ringing', id: 'old', at: Date.now() - 11 * 60000, ts: Date.now() - 11 * 60000 }); saveChat(); });
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2500);
  ok(!(await page.evaluate(() => document.getElementById('callView').classList.contains('on'))), '响了十几分钟前的那通，不会再弹来电');
  ok(await page.evaluate(() => chatLog.find(m => m.id === 'old').state === 'missed'), '记成「未接来电」');

  console.log('\n[打到一半锁屏 / 划掉了 app]');
  await page.evaluate(() => { chatLog.push({ k: 'call', who: 'me', state: 'active', turns: [{ k: 'ai', t: '喂' }], at: Date.now(), ts: Date.now() }); saveChat(); });
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2500);
  ok(await page.evaluate(() => !chatLog.some(m => m.k === 'call' && m.state === 'active')), '再打开时，卡在「通话中」的那张收了尾');

  console.log('\n[他醒过来：发语音、打电话]');
  plan(['{"say":true,"text":"睡了吗","voice":true}']);
  let w = await api('api/wake/test', 'POST', { why: '她说十一点睡' });
  let saved = JSON.parse(fs.readFileSync(DAT + '/chat.json', 'utf8'));
  let msgs = saved.windows.find(x => x.id === saved.active).msgs;
  const lv = msgs[msgs.length - 1];
  ok(lv.k === 'ai' && lv.voice && lv.t === '睡了吗', '醒过来发了一条语音进聊天：' + JSON.stringify({ t: lv.t, voice: lv.voice }));
  plan(['{"say":false,"call":true}']);
  w = await api('api/wake/test', 'POST', { why: '想听她声音' });
  saved = JSON.parse(fs.readFileSync(DAT + '/chat.json', 'utf8'));
  msgs = saved.windows.find(x => x.id === saved.active).msgs;
  const lc = msgs[msgs.length - 1];
  ok(lc.k === 'call' && lc.who === 'ai' && lc.state === 'ringing', '醒过来打了电话：聊天里多了一通正在响的');
  ok(w.said === true, '算他「开口」了一次（受每天上限管着）');
  await page.reload({ waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  ok(await waitFor(() => document.getElementById('callView').classList.contains('on'), 6000), '她打开 app，来电界面直接弹出来');
  await page.click('.cv-btn.end');

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  ok(!errs.length, '页面没报错');
  await b.close();
})();
