const { WORK } = require('../lib/env');
const fs = require('fs');
const B = 'http://localhost:8081'; let cookie = '';
const api = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); try { return { s: r.status, j: JSON.parse(t) }; } catch { return { s: r.status, t }; }
};
const clearSeen = () => {   // 把「她刚说过话」这个状态清掉，好测后面的门
  const f = WORK + '/dat/drives.json';
  if (fs.existsSync(f)) { const d = JSON.parse(fs.readFileSync(f, 'utf8')); delete d.lastUser; fs.writeFileSync(f, JSON.stringify(d)); }
};
const plan = steps => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ i: 0, steps }));
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const chat = async (text) => {
  const r = await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: text }] }) });
  return await r.text();
};
(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  await api('PUT', '/api/quiet', { classes: '', on: true });
  fs.writeFileSync(WORK + '/dat/alarms.json', '[]');
  fs.writeFileSync(WORK + '/dat/wakelog.json', '{}');
  await api('PUT', '/api/state/chat', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [
    { k: 'me', t: '今天食堂遇到件事，挺好笑的', ts: Date.now() - 7200000 },
    { k: 'ai', t: '什么事呀？', ts: Date.now() - 7100000 } ] }] });

  console.log('[A] 他在聊天里偷偷设闹钟（真实工具调用路径）');
  plan([{ tool: 'set_alarm', args: { at: '+120', why: '她说回家再讲食堂那件事' } }, '好，那我等你。']);
  const sse = await chat('我回家再和你说，现在要去上课了');
  const shown = sse.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map(l => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
  console.log('      她屏幕上看到的：「' + shown + '」');
  let al = (await api('GET', '/api/alarms')).j;
  ok(al.list.length === 1, '后台多了 ' + al.list.length + ' 个闹钟：' + (al.list[0] || {}).why);
  ok(!/闹钟|提醒|alarm/i.test(sse), '整条数据流里没有任何闹钟痕迹');

  console.log('[B] 同一件事不记两遍');
  plan([{ tool: 'set_alarm', args: { at: '+150', why: '她说回家再讲食堂那件事' } }, '嗯嗯。']);
  await chat('再见啦');
  ok((await api('GET', '/api/alarms')).j.list.length === 1, '还是 1 个');

  console.log('[C] 下一轮聊天时，他知道自己记着什么');
  const sent = JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
  const sys = sent.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  ok(sys.includes('你自己记着的事') && sys.includes('食堂'), '【现状】里带上了他记着的事');
  ok(sys.includes('她看不见'), '并且告诉他这事她看不见');

  console.log('[D] 到点了但她在上课 → 顺延');
  const p = new Date(Date.now() + 8 * 3600000);
  const dow = '日一二三四五六'[p.getUTCDay()];
  const from = String(p.getUTCHours()).padStart(2, '0') + ':00';
  const to = String(p.getUTCHours()).padStart(2, '0') + ':59';   // 同一小时内，免得跨零点
  await api('PUT', '/api/quiet', { classes: '周' + dow + ' ' + from + '-' + to + ' 高等数学' });
  clearSeen();
  fs.writeFileSync(WORK + '/dat/alarms.json', JSON.stringify([{ id: 'x1', at: Date.now() - 1000, why: '她说回家再讲食堂那件事', win: 'w1', made: Date.now() - 3600000 }]));
  const before = (await api('GET', '/api/state')).j.chat.windows[0].msgs.length;
  const res = (await api('POST', '/api/wake/test', { force: false })).j;
  console.log('      ' + JSON.stringify(res));
  const after = (await api('GET', '/api/alarms')).j.list[0];
  ok((await api('GET', '/api/state')).j.chat.windows[0].msgs.length === before, '上课期间没打扰她');
  ok(after && !after.due, '闹钟还在，推到了 ' + (after && after.when));

  console.log('[E] 下课了 → 说出来');
  await api('PUT', '/api/quiet', { classes: '' });
  clearSeen();
  fs.writeFileSync(WORK + '/dat/alarms.json', JSON.stringify([{ id: 'x1', at: Date.now() - 1000, why: '她说回家再讲食堂那件事', win: 'w1', made: Date.now() - 3600000 }]));
  plan(['{"say":true,"text":"到家了吗？食堂那件事我还等着听呢。","again":null}']);
  await api('POST', '/api/wake/test', { force: false });
  const msgs = (await api('GET', '/api/state')).j.chat.windows[0].msgs;
  ok(msgs[msgs.length - 1].wake === true, '她回来会看到：「' + msgs[msgs.length - 1].t + '」');
  ok((await api('GET', '/api/alarms')).j.list.length === 0, '说完闹钟自动消掉');

  console.log('[F] 一天最多开口 2 次');
  for (const [i, id] of [['第二件事', 'x2'], ['第三件事', 'x3']].entries()) {
    fs.writeFileSync(WORK + '/dat/alarms.json', JSON.stringify([{ id: id[1], at: Date.now() - 1000, why: id[0], win: 'w1', made: Date.now() }]));
    plan(['{"say":true,"text":"' + id[0] + '","again":null}']);
    clearSeen();
    const rr = (await api('POST', '/api/wake/test', { force: false })).j;
    console.log('      第 ' + (i + 2) + ' 次：' + (rr.said ? '说了' : '没说 — ' + (rr.skipped || JSON.stringify(rr))));
  }
  const cnt = (await api('GET', '/api/alarms')).j.today.said;
  ok(cnt <= 2, '今天总共开口 ' + cnt + ' 次，没有超过上限 2');
})();
