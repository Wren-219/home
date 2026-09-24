const { WORK } = require('../lib/env');
/* 会思考的模型调工具。她那天让他「五分钟后喊我」，他嘴上答应了，闹钟却没设上 ——
   两家的规矩：调了工具接着问的时候，刚才那段思考得原样带回去，不然整轮 400。
     · Claude：思考块（带签名）放在 assistant 那条的最前面。claude-opus-5 不开「先想一想」也会想
     · DeepSeek 思考模式：assistant 那条带上 reasoning_content
   假模型都学了这个脾气，没带回去就 400。 */
const fs = require('fs'), B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) C = sc.split(';')[0];
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const read = f => fs.existsSync(WORK + '/' + f) ? JSON.parse(fs.readFileSync(WORK + '/' + f, 'utf8')) : [];
const clr = () => ['areqs.json', 'treqs.json'].forEach(f => fs.rmSync(WORK + '/' + f, { force: true }));
const shown = sse => sse.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
  .map(l => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
const say = async text => {
  const r = await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
    body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: text }], prevTs: Date.now() - 60000 }) });
  return await r.text();
};
const alarms = async () => (await j('/api/alarms')).d.list;
const noAlarms = () => fs.writeFileSync(WORK + '/dat/alarms.json', '[]');
const FIVE = { tool: 'set_alarm', args: { at: '+5', why: '她让我五分钟后喊她' }, think: '她要我五分钟后喊她。记一下。' };

(async () => {
  await j('/api/login', 'POST', { pin: '0527' });
  await j('/api/quiet', 'PUT', { classes: '', on: true });
  noAlarms();

  console.log('[Claude，没开「先想一想」—— opus-5 照样会想]');
  const a = await j('/api/apis', 'POST', { name: '假 Claude', base: 'http://localhost:8098', key: 'sk-a',
    model: 'claude-opus-5', dialect: 'anthropic', think: false, price: { in: 5, out: 25, unit: '$' } });
  const cid = a.d.id;
  await j('/api/apis/use', 'PUT', { chat: cid, worker: cid });
  clr(); plan([FIVE, '好，五分钟后喊你。']);
  let out = await say('五分钟后喊我一下');
  let rq = read('areqs.json');
  ok(!/卡了一下|HTTP 400/.test(out), '没断：「' + shown(out).slice(0, 40) + '」');
  ok(rq.length === 2, '调完工具接着问了一次（共 ' + rq.length + ' 次请求）');
  const back = rq[1] && rq[1].messages.find(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(x => x.type === 'tool_use'));
  ok(back && back.content[0].type === 'thinking' && back.content[0].signature === 'sig-ok', '思考块原样带回去了，签名也在');
  ok(back && !back.content.some(x => x.type === 'thinking' && x.cache_control), '缓存断点没打在思考块上（那样也会 400）');
  let al = await alarms();
  ok(al.length === 1 && /五分钟/.test(al[0].why), '闹钟设上了：' + (al[0] ? al[0].when + ' ' + al[0].why : '没有'));

  console.log('\n[Claude，开了「先想一想」]');
  await j('/api/apis/' + cid, 'PUT', { name: '假 Claude', base: 'http://localhost:8098', model: 'claude-opus-5',
    dialect: 'anthropic', think: true, price: { in: 5, out: 25, unit: '$' } });
  noAlarms(); clr(); plan([FIVE, '好。']);
  out = await say('五分钟后喊我');
  rq = read('areqs.json');
  const back2 = rq[1] && rq[1].messages.find(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(x => x.type === 'tool_use'));
  ok(!/卡了一下/.test(out) && rq.length === 2, '没断');
  ok(back2 && back2.content[0].thinking === FIVE.think, '带回去的就是它刚才那段想法，一个字没改');
  ok((await alarms()).length === 1, '闹钟设上了');

  console.log('\n[Claude，唤醒那条路（不是流式）]');
  noAlarms(); clr();
  plan([{ tool: 'set_alarm', args: { at: '+60', why: '一小时后再问问她到家没' }, think: '先记一下。' }, '{"say":true,"text":"起来啦？","again":null}']);
  let w = (await j('/api/wake/test', 'POST', { why: '她说睡个午觉' })).d;
  rq = read('areqs.json');
  ok(rq.length === 2 && w.said, '醒来调了工具、接着把话说完了：' + JSON.stringify(w).slice(0, 80));
  const back3 = rq[1] && rq[1].messages.find(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(x => x.type === 'tool_use'));
  ok(back3 && back3.content[0].type === 'thinking', '这条路也把思考块带回去了');
  ok((await alarms()).some(x => /到家/.test(x.why)), '醒着设的闹钟也在');

  console.log('\n[DeepSeek 思考模式]');
  await j('/api/apis/use', 'PUT', { chat: 'm1', worker: 'm1' });
  noAlarms(); clr(); plan([FIVE, '好，五分钟后喊你。']);
  out = await say('五分钟后喊我一下');
  rq = read('treqs.json');
  ok(!/卡了一下|reasoning_content/.test(out), '没断：「' + shown(out).slice(0, 40) + '」');
  const tc = rq[1] && rq[1].messages.find(m => m.role === 'assistant' && m.tool_calls);
  ok(tc && tc.reasoning_content === FIVE.think, 'reasoning_content 带回去了');
  ok(tc && !('anthropicBlocks' in tc), '没把 Claude 那套东西混进去');
  ok((await alarms()).length === 1, '闹钟设上了');

  noAlarms(); clr();
  plan([{ tool: 'set_alarm', args: { at: '+60', why: '一小时后再问问她到家没' }, think: '先记一下。' }, '{"say":true,"text":"起来啦？","again":null}']);
  w = (await j('/api/wake/test', 'POST', { why: '她说睡个午觉' })).d;
  rq = read('treqs.json');
  const tc2 = rq[1] && rq[1].messages.find(m => m.role === 'assistant' && m.tool_calls);
  ok(rq.length === 2 && tc2 && tc2.reasoning_content, '唤醒那条路也带回去了');

  console.log('\n[他自己看一眼钟]');
  clr(); plan([{ tool: 'check_now', args: {}, think: '她说早点睡…可我不确定现在几点。' }, '哦，都下午了。']);
  out = await say('你怎么还在说早点睡');
  rq = read('treqs.json');
  const res = rq[1] && rq[1].messages.find(m => m.role === 'tool');
  ok(res && /现在是 \d{4}\.\d\d\.\d\d 周. \d\d:\d\d/.test(res.content), '看到了：' + (res ? res.content.slice(0, 30) : '没看到'));
  ok(rq[0] && rq[0].tools.some(t => t.function.name === 'check_now'), '屋里也有 check_now 了（以前只在 Claude 那边有）');
})();
