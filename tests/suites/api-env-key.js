const { WORK } = require('../lib/env');
/* 她只在 Zeabur 填过 Key。想在界面上换个模型名，不用再把 Key 翻出来填一遍 */
const fs = require('fs'), B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const reqs = () => fs.existsSync(WORK + '/reqs.json') ? JSON.parse(fs.readFileSync(WORK + '/reqs.json', 'utf8')) : [];
const say = async () => (await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
  body: JSON.stringify({ messages: [{ role: 'user', content: '在吗' }] }) })).text();
(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');
  fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: ['在的。'], i: 0 }));

  console.log('[只在服务器上填过 Key，界面上什么都没配]');
  await say();
  ok(reqs().pop().model === 'deepseek-chat', '用的是默认的 deepseek-chat');

  console.log('\n[界面上新建一套：地址一样、Key 留空、只写模型名]');
  const a = await j('/api/apis', 'POST', { name: 'DS flash', base: 'http://localhost:8099', key: '', model: 'deepseek-v4-flash', dialect: 'openai' });
  await j('/api/apis/use', 'PUT', { chat: a.d.id });
  const out = await say();
  ok(reqs().pop().model === 'deepseek-v4-flash' && /在的/.test(out), '换过来了，他照样说话（沿用了服务器上那把 Key）');
  const pub = (await j('/api/apis')).d.list.find(x => x.id === a.d.id);
  ok(pub.keyMask === '用服务器上那把 Key' && pub.hasKey, '列表里写着「用服务器上那把 Key」');
  ok(!JSON.stringify(await j('/api/apis')).includes('sk-env-secret'), '服务器那把 Key 本身不会露出来');

  console.log('\n[地址不一样就不借]');
  const b = await j('/api/apis', 'POST', { name: '别家', base: 'http://localhost:8098', key: '', model: 'x', dialect: 'openai' });
  await j('/api/apis/use', 'PUT', { chat: b.d.id });
  await say();
  ok(reqs().pop().model === 'deepseek-chat', '别家的地址不会拿这把 Key 去用，回落到服务器那套');
})();
