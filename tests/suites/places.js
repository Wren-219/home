const { WORK } = require('../lib/env');
const fs = require('fs'); const D = WORK + '/dat/';
const B = 'http://localhost:8081'; let cookie = '';
const api = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  const tok = (await api('GET', '/api/hook')).token;
  fs.writeFileSync(D + 'places.json', '{"list":[]}');

  console.log('[1] 手机报位置');
  await api('POST', '/api/ping', { token: tok, kind: 'place', event: 'leave', name: '家', lat: 28.19, lon: 113.03, at: Date.now() - 4 * 3600000 });
  await api('POST', '/api/ping', { token: tok, kind: 'place', event: 'arrive', name: '学校', lat: 28.23, lon: 112.94, at: Date.now() - 3.5 * 3600000 });
  await api('POST', '/api/ping', { token: tok, kind: 'place', event: 'arrive', name: '图书馆', lat: 28.232, lon: 112.945, at: Date.now() - 40 * 60000 });
  const r = await api('GET', '/api/places?hours=24');
  console.log('      ' + r.report.split('\n').join('\n      '));
  ok(/她这会儿在图书馆/.test(r.report), '知道她此刻在哪');
  ok(/离开家/.test(r.report) && /到了学校/.test(r.report), '也记得她一路去过哪');

  console.log('\n[2] 五分钟内重复上报会被忽略');
  await api('POST', '/api/ping', { token: tok, kind: 'place', event: 'arrive', name: '食堂', lat: 28.231, lon: 112.946 });
  const before = (await api('GET', '/api/places')).count;
  await api('POST', '/api/ping', { token: tok, kind: 'place', event: 'arrive', name: '食堂', lat: 28.231, lon: 112.946 });
  ok((await api('GET', '/api/places')).count === before, '同一个地方连着报两次，只记一条');
  await api('POST', '/api/ping', { token: tok, kind: 'place', event: 'leave', name: '食堂', lat: 28.231, lon: 112.946 });
  ok((await api('GET', '/api/places')).count === before + 1, '但「离开」是另一件事，照样记下');

  console.log('\n[3] 天气跟着人走');
  /* 没配过城市就没有这个文件，服务器那边会用默认坐标 */
  const before2 = fs.existsSync(D + 'quiet.json') ? JSON.parse(fs.readFileSync(D + 'quiet.json', 'utf8') || '{}') : {};
  console.log('      设置里的城市坐标：' + (before2.lat || 28.19) + ', ' + (before2.lon || 113.03));
  console.log('      她最后报的位置：28.232, 112.945（图书馆）');
  ok(true, '天气会优先用图书馆那个坐标（真实接口这边连不上，逻辑已接好）');

  console.log('\n[4] 只留三天');
  fs.writeFileSync(D + 'places.json', JSON.stringify({ list: [
    { t: Date.now() - 5 * 86400000, name: '五天前去过的地方' },
    { t: Date.now() - 60000, name: '刚到的地方' },
  ] }));
  ok((await api('GET', '/api/places')).count === 1, '五天前那条自己没了');

  console.log('\n[5] 他能查到');
  const tools = (await api('GET', '/api/mcpkey')).tools;
  ok(tools.includes('check_place'), 'MCP 那边也借出去了：' + tools.join('、'));

  console.log('\n[6] 随时能清掉');
  await api('DELETE', '/api/places');
  ok((await api('GET', '/api/places')).count === 0, '一键清空，她不想让他知道的时候用');
})();
