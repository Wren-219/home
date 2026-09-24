const B = 'http://localhost:8081'; let cookie = '';
const api = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  const tok = (await api('GET', '/api/hook')).j.token;
  await api('DELETE', '/api/places');

  console.log('[她截图里那个请求 —— 漏了 kind]');
  const r = await api('POST', '/api/ping', { token: tok, event: 'arrive', name: '老家', lat: 28.19, lon: 113.03 });
  console.log('      ' + JSON.stringify(r.j));
  ok(r.j.ok === true, '现在能自己看出来这是在报位置，不再打回去');
  ok((await api('GET', '/api/places')).j.count === 1, '而且真的记下了');
  console.log('      ' + (await api('GET', '/api/places')).j.report.split('\n')[0]);

  console.log('\n[手机那个漏了 kind 也能认]');
  const r2 = await api('POST', '/api/ping', { token: tok, app: '小红书' });
  ok(r2.j.ok === true, '带 app 的当成「打开了某个 App」');
  const r3 = await api('POST', '/api/ping', { token: tok, app: '小红书', event: 'close' });
  ok(r3.j.ok === true, '带 app + close 的当成「关上了」');

  console.log('\n[真认不出来的时候，话说清楚]');
  const r4 = await api('POST', '/api/ping', { token: tok, hello: 'world' });
  console.log('      ' + JSON.stringify(r4.j));
  ok(r4.s === 400 && /加一个字段 kind/.test(r4.j.error || ''), '告诉她该加什么，而不是只说不对');

  console.log('\n[钥匙还是照验不误]');
  ok((await api('POST', '/api/ping', { token: 'wrong', event: 'arrive', name: 'x', lat: 1, lon: 2 })).s === 401, '猜 kind 归猜 kind，钥匙不对照样挡回去');
})();
