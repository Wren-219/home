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
  const now = Date.now(), M = 60000;
  console.log('[她遇到的那个情况：iOS 一个「关闭」都没报上来]');
  fs.writeFileSync(D + 'phone.json', JSON.stringify({ events: [
    { t: now - 50 * M, app: '小红书', k: 'open' },
    { t: now - 35 * M, app: '微信', k: 'open' },
    { t: now - 12 * M, app: 'Claude', k: 'open' },
  ] }));
  const r = await api('GET', '/api/phone?hours=6');
  console.log('      ' + r.report.split('\n').join('\n      '));
  const live = (r.report.match(/她此刻正开着：(.*)/) || ['', ''])[1];
  ok(!/小红书/.test(live) && !/微信/.test(live), '小红书和微信不再谎报「还开着」');
  ok(/Claude/.test(live), '只剩最后打开的 Claude —— 跟她后台看到的一致');
  ok(/小红书：1 次，共 15 分钟/.test(r.report), '小红书按「到微信打开为止」算了 15 分钟');
  ok(/微信：1 次，共 23 分钟/.test(r.report), '微信按「到 Claude 打开为止」算了 23 分钟');
})();
