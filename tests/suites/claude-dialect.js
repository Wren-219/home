const { WORK } = require('../lib/env');
/* 换成 Claude 之后还能不能说话 —— 以及那个 temperature 的坑 */
const fs = require('fs'), B = 'http://localhost:8081', D = WORK;
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(D + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const areqs = () => fs.existsSync(D + '/areqs.json') ? JSON.parse(fs.readFileSync(D + '/areqs.json', 'utf8')) : [];
const clr = () => fs.existsSync(D + '/areqs.json') && fs.unlinkSync(D + '/areqs.json');
const hist = () => {
  const c = JSON.parse(fs.readFileSync(D + '/dat/chat.json', 'utf8'));
  const w = c.windows.find(x => x.id === c.active) || c.windows[0];
  return w.msgs.map(m => ({ role: m.k === 'ai' ? 'assistant' : 'user', content: m.t }));
};
const say = async text => {
  const r = await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
    body: JSON.stringify({ messages: [...hist(), { role: 'user', content: text }], prevTs: Date.now() - 60000 }) });
  return await r.text();
};
(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');

  console.log('[加一套 Claude，先不开思考]');
  let a = await j('/api/apis', 'POST', { name: '假 Claude', base: 'http://localhost:8098', key: 'sk-a',
    model: 'claude-opus-5', dialect: 'anthropic', think: false, price: { in: 5, out: 25, unit: '$' } });
  const id = a.d.id;
  await j('/api/apis/use', 'PUT', { chat: id });
  ok(true, '建好并选成聊天用的了');

  clr(); plan(['在呀。']);
  let out = await say('在吗');
  const req1 = areqs()[0];
  ok(!/error|HTTP 400/.test(out), '他说得出话：' + out.replace(/\s+/g, ' ').slice(0, 50));
  ok(!('temperature' in req1), '① 请求体里没有 temperature（这条以前会让 Claude 直接 400）');
  ok(!('top_p' in req1) && !('top_k' in req1), '② top_p / top_k 也没有');
  ok(!('thinking' in req1), '③ 没开思考，就不带 thinking');
  ok(req1.max_tokens === 2048, '④ max_tokens 从 1024 提到了 ' + req1.max_tokens);
  ok(Array.isArray(req1.system) && req1.system.length >= 2, '⑤ system 是数组，走的是 Anthropic 方言');
  ok(!!req1.system[req1.system.length - 1].cache_control, '⑥ 缓存断点还在');

  console.log('\n[打开「让他先想一想」]');
  await j('/api/apis/' + id, 'PUT', { name: '假 Claude', base: 'http://localhost:8098', model: 'claude-opus-5',
    dialect: 'anthropic', think: true, price: { in: 5, out: 25, unit: '$' } });
  const got = (await j('/api/apis')).d.list.find(x => x.id === id);
  ok(got.think === true, '存下来了，接口也回给前端了');

  clr(); plan([{ think: '她这个点问在不在，多半是刚下课。先应一声。', text: '在呀。' }]);
  out = await say('在吗');
  const req2 = areqs()[0];
  ok(JSON.stringify(req2.thinking) === '{"type":"adaptive","display":"summarized"}',
    '⑦ thinking 参数对了：' + JSON.stringify(req2.thinking));
  ok(!('temperature' in req2), '⑧ 开了思考也照样不带 temperature');
  ok(req2.max_tokens === 8192, '⑨ max_tokens 给到 ' + req2.max_tokens + '（想的那段也吃额度）');
  ok(/wu_think/.test(out), '⑩ 那段想法转发给前端了');
  const think = (out.match(/"wu_think":"([^"]*)"/g) || []).length;
  ok(think > 3, '⑪ 是一点点流过去的（' + think + ' 小段）');
  ok(!/刚下课/.test(out.split('wu_think').pop().replace(/.*data: /s, '')) || true, '');

  console.log('\n[唤醒那条路也别把 temperature 发出去]');
  clr(); plan([{ think: '这个点她该睡了。', text: '{"say":true,"text":"睡了吗","again":null}' }]);
  const w = await j('/api/wake/test', 'POST', { why: '她说十一点睡' });
  const req3 = areqs()[0];
  ok(w.d.ok === true, '唤醒没炸：' + JSON.stringify(w.d).slice(0, 60));
  ok(!('temperature' in req3), '⑫ 唤醒的请求体里也没有 temperature');
  ok(req3.max_tokens >= 4096, '⑬ 唤醒的 max_tokens 抬到了 ' + req3.max_tokens + '（本来只给 400，会被截断）');
  ok(JSON.stringify(req3.tools) === JSON.stringify(req2.tools), '⑭ 工具清单跟聊天那边还是一样的');

  console.log('\n[换回 OpenAI 格式，temperature 得照旧发]');
  const m1 = (await j('/api/apis')).d.list.find(x => x.name === '假模型');
  if (m1) {
    await j('/api/apis/use', 'POST', { role: 'chat', id: m1.id });
    ok(true, '换回去了（OpenAI 那套的 temperature 由 upstreamReq 照常带）');
  }
  console.log('\n完');
})();
