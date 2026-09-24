/* 声音（一）：设置、他发语音、她按住说话、省钱闸、没配好时工具不露面 */
const { WORK, chromiumPath } = require('../lib/env');
const { chromium } = require('playwright-core'); const fs = require('fs');
const fakeMic = require('../lib/fake-mic');
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const eleven = () => fs.existsSync(WORK + '/eleven.json') ? JSON.parse(fs.readFileSync(WORK + '/eleven.json', 'utf8')) : [];
const last = () => JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
(async () => {
  fs.rmSync(WORK + '/eleven.json', { force: true });
  const mic = fakeMic(WORK + '/mic.wav');
  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + mic, '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 393, height: 852 } });
  await ctx.grantPermissions(['microphone'], { origin: 'http://localhost:8081' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto('http://localhost:8081', { waitUntil: 'networkidle' });
  for (const d of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(2000);
  const api = (p, m, body) => page.evaluate(async ([p, m, body]) => (await fetch(p, { method: m || 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json(), [p, m, body]);
  const chat = async text => {
    await page.fill('#chatInput', text); await page.click('#sendBtn'); await page.waitForTimeout(2500);
  };

  console.log('[还没配声音]');
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(500);
  ok(!(await page.isVisible('#callBtn')), '聊天页右上角还没有电话按钮');
  plan(['嗯']);
  await chat('在吗');
  const names = (last().tools || []).map(t => t.function.name);
  ok(!names.includes('send_voice') && !names.includes('call_her'), '没配好声音，「发语音」「打电话」两件工具不摆给他');

  console.log('\n[在设置里配上]');
  await page.evaluate(() => { document.querySelector('.tab[data-page="settings"]').click(); });
  await page.waitForTimeout(600);
  await page.evaluate(() => openSub('voice'));
  await page.waitForTimeout(600);
  await page.fill('#vKey', 'el-good');
  await page.fill('#vVoice', 'wu-voice-id');
  await page.click('#page-voice .sp-act');
  await page.waitForTimeout(800);
  const cfg = await api('api/voice');
  ok(cfg.ready && cfg.hasKey && cfg.voiceId === 'wu-voice-id', '存上了：' + JSON.stringify({ ready: cfg.ready, voiceId: cfg.voiceId }));
  ok(!JSON.stringify(cfg).includes('el-good'), '接口回给界面的数据里没有钥匙本身');
  ok(/已存/.test(await page.getAttribute('#vKey', 'placeholder')), '钥匙框只显示「已存」');
  await page.click('#page-voice button:has-text("让他说一句")');
  await page.waitForTimeout(1500);
  const t1 = eleven().filter(x => x.text).pop();
  ok(t1 && t1.text === '在的。这是我的声音。' && t1.model === 'eleven_multilingual_v2' && t1.path === '/v1/text-to-speech/wu-voice-id',
     '「让他说一句」真的去念了：' + JSON.stringify(t1));
  await page.evaluate(() => closeSub('voice'));
  await page.evaluate(() => document.querySelector('.tab[data-page="chat"]').click());
  await page.waitForTimeout(500);
  ok(await page.isVisible('#callBtn'), '电话按钮出来了');

  console.log('\n[他发一条语音]');
  plan([{ tool: 'send_voice', args: { text: '（小声）晚安，早点睡。' } }, '好梦']);
  await chat('我要睡啦');
  const names2 = (last().tools || []).map(t => t.function.name);
  ok(names2.includes('send_voice') && names2.includes('call_her'), '配好之后两件工具都摆给他了');
  const vmsg = await page.evaluate(() => chatLog.filter(m => m.voice && m.k === 'ai').pop());
  ok(vmsg && /^\/files\/.+\.wav$/.test(vmsg.voice) && vmsg.t === '（小声）晚安，早点睡。', '聊天里多了一条他的语音：' + JSON.stringify(vmsg));
  const said = eleven().filter(x => x.text).pop();
  ok(said.text === '晚安，早点睡。', '念的时候跳过了「（小声）」：' + said.text);
  ok(await page.isVisible('.bub.voice.ai'), '语音气泡画出来了');
  const order = await page.evaluate(() => chatLog.slice(-2).map(m => (m.voice ? '语音' : '') + m.t));
  ok(order[0].startsWith('语音') && order[1] === '好梦', '先是语音、再是他后面说的那句：' + order.join(' / '));
  await page.click('.bub.voice.ai .vi');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => !!vPlayingEl), '点一下能放');
  await page.click('.v-text.ai .tog');
  ok((await page.textContent('.v-text.ai')).includes('晚安'), '「转文字」点开能看到字');
  const api1 = await page.evaluate(() => toApiMessages().map(m => m.content).filter(c => c.includes('晚安')));
  ok(api1[0] === '（语音）（小声）晚安，早点睡。', '他那边的记录里：' + api1[0]);

  console.log('\n[她按住说话]');
  fs.writeFileSync(WORK + '/stt.txt', '今天好累呀');
  plan(['辛苦啦']);
  const mb = await page.locator('#micBtn').boundingBox();
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  ok(await page.isVisible('#holdTip'), '按下去，「松开发送，上滑取消」出来了');
  await page.waitForTimeout(1800);
  await page.mouse.up();
  await page.waitForTimeout(3500);
  const mine = await page.evaluate(() => chatLog.filter(m => m.k === 'me' && m.voice).pop());
  ok(mine && mine.t === '今天好累呀' && /^\/files\//.test(mine.voice), '她的语音发出去了，识别出来的字也在：' + JSON.stringify(mine));
  const heard = eleven().filter(x => x.path === '/v1/speech-to-text').pop();
  ok(heard && heard.model === 'scribe_v2' && heard.size > 1000, '交给 ElevenLabs 听写了（scribe_v2，' + (heard && heard.size) + ' 字节）');
  ok((await page.textContent('.v-text.me')).includes('今天好累呀'), '她自己那条下面直接显示识别出来的字');
  ok(await page.evaluate(() => chatLog[chatLog.length - 1].t === '辛苦啦'), '然后他照常回了话');
  const sent = last().messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  ok(sent.includes('（语音）今天好累呀'), '他收到的是「（语音）今天好累呀」');
  ok(await page.evaluate(() => !micStream), '录完麦克风关掉了（iPhone 顶上的橙点不会一直亮）');

  console.log('\n[按一下就松手]');
  const before = await page.evaluate(() => chatLog.length);
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down(); await page.waitForTimeout(300); await page.mouse.up();
  await page.waitForTimeout(800);
  ok((await page.textContent('#toast')).includes('太短'), '提示「说话时间太短」');
  ok((await page.evaluate(() => chatLog.length)) === before, '什么都没发');

  console.log('\n[上滑取消]');
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down(); await page.waitForTimeout(1200);
  await page.mouse.move(mb.x + mb.width / 2, mb.y - 120); await page.waitForTimeout(200);
  ok((await page.textContent('#holdTip .tx')).includes('取消'), '滑上去提示变成「松开手指，取消发送」');
  await page.mouse.up(); await page.waitForTimeout(800);
  ok((await page.evaluate(() => chatLog.length)) === before, '松手也没发');

  console.log('\n[省钱闸]');
  await api('api/voice', 'PUT', { dayCap: 5 });
  const n0 = eleven().length;
  plan([{ tool: 'send_voice', args: { text: '这一句很长很长很长' } }, '嗯']);
  await chat('再说一句');
  const logs = await page.evaluate(() => fetch('api/voice').then(r => r.json()));
  ok(eleven().length === n0, '到了今天的字数上限，就不再去念了');
  ok(!(await page.evaluate(() => chatLog.slice(-3).some(m => m.voice && m.t.includes('很长')))), '也没长出语音气泡（他会收到「到上限了」，改回打字）');
  ok(logs.today.chars > 0, '今天念了多少字记着：' + logs.today.chars);
  await api('api/voice', 'PUT', { dayCap: 6000 });

  console.log('\n[关掉「让他能发语音」]');
  await api('api/voice', 'PUT', { on: false });
  plan(['嗯']);
  await chat('1');
  const names3 = (last().tools || []).map(t => t.function.name);
  ok(!names3.includes('send_voice') && names3.includes('call_her'), '「发语音」撤下了，「打电话」还在');
  await api('api/voice', 'PUT', { on: true });

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  ok(!errs.length, '页面没报错');
  await b.close();
})();
