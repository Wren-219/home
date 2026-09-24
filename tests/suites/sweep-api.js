const { ROOT } = require('../lib/env');
const fs = require('fs'), B = 'http://localhost:8081';
const src = fs.readFileSync(ROOT + '/server.js', 'utf8');
const routes = [...src.matchAll(/p === "(\/api\/[^"]+)" && req\.method === "(\w+)"/g)].map(m => [m[2], m[1]]);
const prefix = [...src.matchAll(/p\.startsWith\("(\/api\/[^"]+)"\)(?: && p\.endsWith\("([^"]+)"\))? && (?:req\.method === "(\w+)"|\(req\.method === "(\w+)" \|\| req\.method === "(\w+)"\))/g)]
  .map(m => [m[3] || m[4] + '|' + m[5], m[1] + 'nope' + (m[2] || '')]);
/* 这几个会真的干活（清数据、发邮件、叫醒他、换钥匙），巡检时跳过 */
const SKIP = /\/api\/(state|reset|wipe|pin|login|logout|mail\/test|wake\/test|push\/test|hookkey|mcpkey|import|backup|restore|chat|distill|dream|upload|alarms$)/;
(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  const C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');
  const bad = [];
  let n = 0;
  const hit = async (method, path, body, tag) => {
    n++;
    try {
      const x = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', Cookie: C }, body });
      const t = await x.text();
      if (x.status >= 500) bad.push(`${x.status}  ${method} ${path} ${tag}  →  ${t.slice(0, 110)}`);
    } catch (e) { bad.push(`崩了  ${method} ${path} ${tag}  →  ${e.message}`); }
  };
  for (const [m, p] of routes) {
    if (m === 'GET') await hit('GET', p, undefined, '');
    else if (!SKIP.test(p)) {
      await hit(m, p, '', '(空 body)');
      await hit(m, p, '{不是json', '(乱码)');
      await hit(m, p, '[]', '(数组)');
    }
  }
  for (const [m, p] of prefix) for (const mm of m.split('|')) if (mm !== 'undefined') {
    await hit(mm, p, mm === 'GET' ? undefined : '', '(不存在的 id)');
  }
  /* 没登录的时候，敏感接口必须拒绝 */
  const leak = [];
  for (const [m, p] of routes.filter(([m]) => m === 'GET')) {
    const x = await fetch(B + p);
    if (x.status === 200 && !/\/api\/(health|ping)/.test(p)) leak.push(p);
  }
  console.log('路由 ' + routes.length + ' 条 + 带 id 的 ' + prefix.length + ' 条，一共打了 ' + n + ' 次');
  console.log((bad.length ? '  XX  ' : '  OK  ') + '没有 500 / 崩溃' + (bad.length ? '：\n        ' + bad.join('\n        ') : ''));
  console.log((leak.length ? '  XX  ' : '  OK  ') + '没登录时所有 GET 都拒绝' + (leak.length ? '：' + leak.join(', ') : ''));
})();
