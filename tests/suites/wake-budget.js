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
const setAlarm = why => fs.writeFileSync(D + 'alarms.json', JSON.stringify([{ id: 'a' + Math.random().toString(36).slice(2, 6), at: Date.now() - 1000, why, win: 'w1', made: Date.now() }]));

(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  fs.writeFileSync(D + 'wakelog.json', '{}');
  fs.writeFileSync(D + 'alarms.json', '[]');
  await api('PUT', '/api/quiet', { classes: '', on: true, maxWakePerDay: 4, maxPerDay: 2 });
  await api('PUT', '/api/state/chat', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [
    { k: 'me', t: '今天好累啊', ts: Date.now() - 7200000 }, { k: 'ai', t: '辛苦了。', ts: Date.now() - 7100000 } ] }] });

  console.log('[1] 他一直「想了想没说话」—— 这才是烧钱的那种场景');
  plan(['{"say":false,"text":"","again":null}']);
  for (let i = 1; i <= 6; i++) {
    clearSeen(); setAlarm('第 ' + i + ' 次琢磨');
    const r = (await api('POST', '/api/wake/test', { force: false })).j;
    const q = (await api('GET', '/api/quiet')).j.today;
    console.log(`      第 ${i} 次：${r.said ? '说了' : (r.skipped ? '被拦下（' + r.skipped + '）' : '醒了但没说')}  ｜ 累计醒 ${q.woke} 次`);
  }
  let q = (await api('GET', '/api/quiet')).j;
  ok(q.today.woke === 4, `醒到第 4 次就被闸住了（实际 ${q.today.woke} 次，上限 ${q.maxWakePerDay}）`);
  ok(q.today.said === 0, '全程一句没说 —— 但每次都花了钱，所以必须记账');
  ok((q.today.cost || 0) > 0, `账记下来了：${(q.today.unit || '￥')}${(q.today.cost || 0).toFixed(4)}`);

  console.log('\n[2] 记着的事有数量上限');
  fs.writeFileSync(D + 'alarms.json', JSON.stringify(
    Array.from({ length: 10 }, (_, i) => ({ id: 'p' + i, at: Date.now() + 86400000, why: '第 ' + i + ' 件事', win: 'w1', made: Date.now() }))));
  plan([{ tool: 'set_alarm', args: { at: '+300', why: '再记一件全新的事' } }, '嗯。']);
  await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: '随便说点什么' }] }) });
  const n = (await api('GET', '/api/alarms')).j.list.length;
  ok(n === 10, `已经记着 10 件，第 11 件被挡住了（现在 ${n} 件）`);

  console.log('\n[3] 「晚点再想一次」不能无限续');
  fs.writeFileSync(D + 'wakelog.json', '{}');
  await api('PUT', '/api/quiet', { maxWakePerDay: 50 });
  fs.writeFileSync(D + 'alarms.json', JSON.stringify([{ id: 'sn', at: Date.now() - 1000, why: '一直往后拖的事', win: 'w1', made: Date.now() }]));
  plan(['{"say":false,"text":"","again":1}']);
  for (let i = 0; i < 5; i++) {
    clearSeen();
    const l = (await api('GET', '/api/alarms')).j.list;
    if (!l.length) { console.log(`      第 ${i + 1} 轮：闹钟已经没了`); break; }
    fs.writeFileSync(D + 'alarms.json', JSON.stringify(l.map(a => ({ ...a, at: Date.now() - 1000 }))));
    await api('POST', '/api/wake/test', { force: false });
    const after = (await api('GET', '/api/alarms')).j.list;
    console.log(`      第 ${i + 1} 轮：${after.length ? '又往后拖了（snoozed=' + (after[0].snoozed || 0) + '）' : '拖够三次，这件事算了'}`);
  }
  ok((await api('GET', '/api/alarms')).j.list.length === 0, '拖到第 4 次就丢掉了，不会永远醒下去');

  console.log('\n[4] 急停：全忘掉');
  fs.writeFileSync(D + 'alarms.json', JSON.stringify([{ id: 'z1', at: Date.now() + 99999, why: 'a', win: 'w1', made: Date.now() }, { id: 'z2', at: Date.now() + 99999, why: 'b', win: 'w1', made: Date.now() }]));
  const c = (await api('DELETE', '/api/alarms')).j;
  ok(c.cleared === 2 && (await api('GET', '/api/alarms')).j.list.length === 0, `一键清掉了 ${c.cleared} 件`);

  console.log('\n[5] 账目能查到');
  q = (await api('GET', '/api/quiet')).j;
  console.log(`      今天醒 ${q.today.woke} 次 / 开口 ${q.today.said} 次 · 累计醒 ${q.today.allTime.woke} 次 · 共 ${(q.today.unit||'￥')}${(q.today.allTime.cost||0).toFixed(4)} · 这会儿记着 ${q.pending} 件`);
  ok(q.today.allTime.woke > 0 && q.pending === 0, '次数、花销、记着几件 —— 都报得出来');
})();
