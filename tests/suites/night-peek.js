const { WORK } = require('../lib/env');
const fs = require('fs');
const B = 'http://localhost:8081'; let cookie = '';
const api = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, t }; }
};
const plan = steps => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ i: 0, steps }));
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const D = WORK + '/dat/';
const clearSeen = () => { const f = D + 'drives.json'; if (fs.existsSync(f)) { const d = JSON.parse(fs.readFileSync(f, 'utf8')); delete d.lastUser; fs.writeFileSync(f, JSON.stringify(d)); } };
const alarm = why => fs.writeFileSync(D + 'alarms.json', JSON.stringify([{ id: 'x', at: Date.now() - 1000, why, win: 'w1', made: Date.now() }]));
const nowP = new Date(Date.now() + 8 * 3600000);
const hh = nowP.getUTCHours();

(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  fs.writeFileSync(D + 'wakelog.json', '{}');
  await api('PUT', '/api/state/chat', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [
    { k: 'me', t: '我今天十一点就睡，说到做到', ts: Date.now() - 7200000 },
    { k: 'ai', t: '好，那我等你的好消息。', ts: Date.now() - 7100000 } ] }] });
  // 把「现在」设成夜里：让夜间时段覆盖此刻
  await api('PUT', '/api/quiet', { classes: '', nightStart: (hh + 23) % 24, nightEnd: (hh + 1) % 24, minGapMin: 5, maxPerDay: 5, maxWakePerDay: 20, nightPeek: true });
  console.log(`（把「夜里」设成覆盖此刻 ${hh} 点，好测抓现行）`);

  console.log('\n[1] 她睡了（手机三小时没动静）→ 他不出声');
  fs.writeFileSync(D + 'phone.json', JSON.stringify({ events: [
    { t: Date.now() - 3 * 3600000, app: '小红书', k: 'open' },
    { t: Date.now() - 3 * 3600000 + 600000, app: '小红书', k: 'close' } ] }));
  clearSeen(); alarm('她说十一点睡，看看做到没');
  let r = (await api('POST', '/api/wake/test', { force: false })).j;
  ok(String(r.skipped || '').includes('夜里'), '被拦下：' + (r.skipped || JSON.stringify(r)));

  console.log('\n[2] 她还在刷手机 → 门开了，他可以抓现行');
  fs.writeFileSync(D + 'phone.json', JSON.stringify({ events: [
    { t: Date.now() - 42 * 60000, app: '小红书', k: 'open' } ] }));   // 开着没关
  clearSeen(); alarm('她说十一点睡，看看做到没');
  plan(['{"say":true,"text":"说好十一点睡的。小红书好看吗？","again":null}']);
  r = (await api('POST', '/api/wake/test', { force: false })).j;
  ok(r.said === true, '他冒出来了：「' + (r.text || '') + '」');

  console.log('\n[3] 他醒来时确实看到了手机动静');
  const sent = JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
  const all = sent.messages.map(m => m.content).join('\n');
  ok(/【她的手机】/.test(all), '唤醒上下文里有【她的手机】那一段');
  const seg = (all.match(/【她的手机】[^\n]*/) || [''])[0];
  console.log('      ' + seg);
  ok(/正开着/.test(seg) && /42 分钟|4[0-9] 分钟/.test(seg), '他知道她正开着、开了多久');

  console.log('\n[4] 关掉那个开关 → 夜里一律不出声');
  await api('PUT', '/api/quiet', { nightPeek: false });
  fs.writeFileSync(D + 'wakelog.json', '{}');
  clearSeen(); alarm('再看一次');
  r = (await api('POST', '/api/wake/test', { force: false })).j;
  ok(String(r.skipped || '').includes('夜里'), '即使她在玩手机也不出声：' + (r.skipped || ''));

  console.log('\n[5] 白天照常（不受这个开关影响）');
  await api('PUT', '/api/quiet', { nightStart: 23, nightEnd: 8, nightPeek: true });
  fs.writeFileSync(D + 'wakelog.json', '{}');
  clearSeen(); alarm('白天的事');
  plan(['{"say":true,"text":"白天正常说话","again":null}']);
  r = (await api('POST', '/api/wake/test', { force: false })).j;
  const isNight = hh >= 23 || hh < 8;
  ok(isNight ? true : r.said === true, isNight ? '（此刻真的是夜里，跳过这条）' : '白天该说就说');
})();
