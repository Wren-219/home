/* 上网这套的接口测试。走真的 HTTP 打服务器，只把外网那三家拦下来 */
const B = 'http://localhost:8081';
let PIN = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: PIN }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  PIN = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(x => x.split(';')[0]).join('; ');
  ok(r.ok, '登进去了');

  console.log('\n[还没配钥匙的时候]');
  let g = await j('/api/search');
  ok(g.d.hasKey === false && g.d.ready === false, '接口说还没配');
  ok(g.d.vendors.length === 3, '三家都列出来了');
  let t = await j('/api/search/try', 'POST', { query: '随便' });
  ok(/还没配/.test(t.d.text) && t.d.ok === false, '试搜回：' + t.d.text.slice(0, 20));

  console.log('\n[钥匙填错]');
  await j('/api/search', 'PUT', { vendor: 'tavily', key: 'tv-bad' });
  t = await j('/api/search/try', 'POST', { query: '随便' });
  ok(/401/.test(t.d.text) && t.d.ok === false, '老实说搜不了，没编：' + t.d.text.slice(0, 40));

  console.log('\n[Tavily]');
  await j('/api/search', 'PUT', { key: 'tv-good' });
  t = await j('/api/search/try', 'POST', { query: '今天星期几' });
  ok(t.d.ok, '通了');
  ok(/一句话答案/.test(t.d.text) && /今天是星期三/.test(t.d.text), 'answer 提到最前面');
  ok(/https:\/\/a\.example\/1/.test(t.d.text), '带上了链接');
  ok(!/\n  带换行/.test(t.d.text), '摘要里的换行和多空格压平了');
  const longLine = t.d.text.split('\n').find(l => /xxxx/.test(l));
  ok(longLine.length < 320, '太长的摘要截到 300 字以内（' + longLine.length + '）');

  console.log('\n[换 Brave —— 只换家，不重填钥匙]');
  await j('/api/search', 'PUT', { vendor: 'brave' });
  t = await j('/api/search/try', 'POST', { query: 'x' });
  ok(/422/.test(t.d.text), 'Tavily 的钥匙在 Brave 上当然不认（说明钥匙没被清掉也没串用）');
  await j('/api/search', 'PUT', { key: 'br-good' });
  t = await j('/api/search/try', 'POST', { query: 'x' });
  ok(t.d.ok && /Brave 一/.test(t.d.text) && /brave 摘要/.test(t.d.text), 'Brave 的形状也拆对了');

  console.log('\n[换博查]');
  await j('/api/search', 'PUT', { vendor: 'bocha', key: 'bo-good' });
  t = await j('/api/search/try', 'POST', { query: 'x' });
  ok(t.d.ok && /博查一/.test(t.d.text) && /长一点的总结/.test(t.d.text), '博查优先用 summary 而不是 snippet');

  console.log('\n[钥匙只进不出]');
  g = await j('/api/search');
  ok(g.d.hasKey === true && !JSON.stringify(g.d).includes('bo-good'), '接口回的数据里没有钥匙本身');

  console.log('\n[关掉「让他能上网」]');
  await j('/api/search', 'PUT', { on: false });
  t = await j('/api/search/try', 'POST', { query: 'x' });
  ok(/关掉了/.test(t.d.text), '他就上不了网了');
  g = await j('/api/search');
  ok(g.d.hasKey === true && g.d.ready === false, '钥匙还留着，只是不让用');
  await j('/api/search', 'PUT', { on: true });

  console.log('\n[读网页]');
  const read = async u => (await j('/api/search/try', 'POST', { query: 'x' }), null);
  // 直接用工具通道读，更接近他真实的用法
  const mcpKey = (await j('/api/mcpkey')).d.key;
  const call = async (name, args) => {
    const r = await fetch(B + '/mcp/' + mcpKey, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const d = await r.json();
    return ((d.result || {}).content || [{}])[0].text || JSON.stringify(d);
  };
  let w = await call('read_web', { url: 'https://page.example/a' });
  ok(/一篇文章/.test(w), '标题读出来了');
  ok(/标题在这儿/.test(w) && /第一段 正文&符号/.test(w), '正文和实体都还原了');
  ok(!/alert|color:red|var x=1/.test(w), '脚本和样式没混进来');
  ok(/第一段[\s\S]*\n[\s\S]*第二段/.test(w), '段落之间断了行');

  w = await call('read_web', { url: '小红书发给你的那个' });
  ok(/不像个网址/.test(w), '不是网址的老实说不是');
  w = await call('read_web', { url: 'https://pdf.example/x' });
  ok(/不是网页/.test(w), 'PDF 说读不了');
  w = await call('read_web', { url: 'https://gone.example/x' });
  ok(/404/.test(w), '404 如实报');

  console.log('\n[没配钥匙就不该把这两件工具摆出来]');
  await j('/api/search', 'PUT', { clearKey: true });
  g = await j('/api/search');
  ok(g.d.hasKey === false, '钥匙清掉了');
  console.log('\n完');
})();
