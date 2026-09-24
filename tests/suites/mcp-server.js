const { ROOT, WORK } = require('../lib/env');
const fs = require('fs'); const D = WORK + '/dat/';
const B = 'http://localhost:8081'; let cookie = '';
const api = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
let seq = 0, session = null, URL_;
/* 照搬她 server.js 里 mcpRpc 的写法，等于拿她的客户端连她的服务端 */
const rpc = async (method, params) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (session) headers['Mcp-Session-Id'] = session;
  const r = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params: params || {} }) });
  const sid = r.headers.get('mcp-session-id'); if (sid) session = sid;
  const text = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + '：' + text.slice(0, 120));
  let payload = null;
  if (text.trim().startsWith('{')) payload = JSON.parse(text);
  else for (const ln of text.split('\n')) { const t = ln.trim(); if (t.startsWith('data:')) { try { const j = JSON.parse(t.slice(5).trim()); if (j.result || j.error) payload = j; } catch {} } }
  if (!payload) throw new Error('没读懂对方的回复');
  if (payload.error) throw new Error(payload.error.message);
  return payload.result;
};
(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  const key = (await api('GET', '/api/mcpkey')).key;
  URL_ = B + '/mcp/' + key;
  console.log('钥匙拿到了，长 ' + key.length + ' 位\n');

  console.log('[1] 钥匙不对 → 当这地址不存在');
  const bad = await fetch(B + '/mcp/wrongkey', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
  ok(bad.status === 404, '假钥匙回 404（不是 401 —— 不告诉人这儿有扇门）');

  console.log('\n[2] 握手');
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  console.log('      ' + JSON.stringify(init).slice(0, 150));
  ok(init.protocolVersion === '2025-06-18' && init.capabilities.tools, '协议版本和能力都回了');
  ok(!!session, '会话号发回来了：' + String(session).slice(0, 12) + '…');
  ok(/家/.test(init.instructions || ''), '带了一句给他的开场白');

  console.log('\n[3] 通知不用回话');
  const nr = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  ok(nr.status === 202, 'notifications/initialized 回 202');

  console.log('\n[4] 他能拿到哪些工具');
  const tl = await rpc('tools/list', {});
  console.log('      ' + tl.tools.map(t => t.name).join('、'));
  const want = (require('fs').readFileSync(ROOT + '/server.js', 'utf8').match(/const MCP_TOOLS = \[[\s\S]*?\n\];/)[0].match(/\{ name: "/g) || []).length;
  ok(tl.tools.length === want, `${tl.tools.length} 件工具，跟服务器里 MCP_TOOLS 的数目一致`);
  ok(tl.tools.every(t => t.inputSchema && t.inputSchema.type === 'object'), '每件都带着合规的参数表');

  console.log('\n[5] 真的调起来');
  fs.writeFileSync(D + 'phone.json', JSON.stringify({ events: [{ t: Date.now() - 25 * 60000, app: '小红书', k: 'open' }] }));
  const call = async (n, a) => (await rpc('tools/call', { name: n, arguments: a || {} }));
  const r1 = await call('check_phone', { hours: 6 });
  console.log('      check_phone → ' + r1.content[0].text.split('\n')[1]);
  ok(/小红书/.test(r1.content[0].text), 'check_phone 查到了真实记录');
  const r2 = await call('check_now');
  console.log('      check_now → ' + r2.content[0].text.slice(0, 60) + '…');
  ok(/现在是 \d{4}\./.test(r2.content[0].text), 'check_now 知道她那边几点');
  await call('remember', { content: '她把晤接进了 Claude 那边', type: '事件', importance: 4 });
  const r3 = await call('recall', { query: 'Claude' });
  console.log('      recall → ' + r3.content[0].text.slice(0, 60));
  ok(/Claude/.test(r3.content[0].text), 'remember 写进去了、recall 又翻了出来');

  console.log('\n[6] 出岔子的时候');
  const r4 = await call('read_doc', { name: '根本不存在的资料' });
  ok(r4.content[0].text.length > 0, '工具自己出错时照常回话，不会把连接搞断');
  let errCode = 0;
  try { await rpc('nonexistent/method', {}); } catch (e) { errCode = 1; }
  ok(errCode === 1, '不认识的方法会明确报错');

  console.log('\n[7] 其它几个动作');
  const g = await fetch(URL_, { method: 'GET' });
  ok(g.status === 405, 'GET（服务端推送流）回 405 —— 规范里它是可选的');
  const d = await fetch(URL_, { method: 'DELETE' });
  ok(d.status === 204, 'DELETE（结束会话）回 204');
  const o = await fetch(URL_, { method: 'OPTIONS' });
  ok(o.status === 204 && o.headers.get('access-control-allow-methods'), 'OPTIONS 预检回 204 + CORS 头');
})();
