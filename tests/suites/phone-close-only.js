const { WORK } = require('../lib/env');
const fs = require('fs'); const D = WORK + '/dat/';
const B = 'http://localhost:8081'; let cookie = '';
const api = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  const now = Date.now();
  console.log('[只配了「关闭」那一个自动化的情况]');
  fs.writeFileSync(D + 'phone.json', JSON.stringify({ events: [
    { t: now - 90 * 60000, app: '小红书', k: 'close' },
    { t: now - 40 * 60000, app: '微信', k: 'close' },
    { t: now - 8 * 60000, app: '小红书', k: 'close' },
  ] }));
  const r = (await api('GET', '/api/phone?hours=24')).j;
  console.log('      ' + r.report.split('\n').join('\n      '));
  ok(/小红书：2 次/.test(r.report), '孤立的关闭事件也报出来了（以前这里是「没有记录」）');
  ok(/算不出用了多久/.test(r.report), '并且老实说明算不出时长');

  console.log('\n[两个都配齐的情况 —— 对照]');
  fs.writeFileSync(D + 'phone.json', JSON.stringify({ events: [
    { t: now - 90 * 60000, app: '小红书', k: 'open' },
    { t: now - 48 * 60000, app: '小红书', k: 'close' },
    { t: now - 8 * 60000, app: '小红书', k: 'open' },
  ] }));
  const r2 = (await api('GET', '/api/phone?hours=24')).j;
  console.log('      ' + r2.report.split('\n').join('\n      '));
  ok(/共 50 分钟/.test(r2.report) && /还开着/.test(r2.report), '算得出时长，也知道此刻还开着');
})();
