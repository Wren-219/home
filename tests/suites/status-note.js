const { ROOT, WORK } = require('../lib/env');
const fs = require('fs'); const D = WORK + '/dat/';
const B = 'http://localhost:8081'; let cookie = '';
const api = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
};
const plan = steps => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ i: 0, steps }));
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const chat = async (text, prevTs) => {
  await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: text }], prevTs }) });
  const sent = JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
  return sent.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
};
(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  await api('PUT', '/api/quiet', { classes: '周一 08:00-09:40 高等数学\n周一 10:00-11:40 大学英语\n周二 14:00-15:40 体育\n周三 08:00-09:40 近代史\n周四 10:00-11:40 线性代数\n周五 14:00-15:40 选修' });
  await api('POST', '/api/ping', { token: (await api('GET', '/api/hook')).token, kind: 'agenda', text: '09:00 高等数学 教三301\n14:00 见导师\n19:30 社团例会' });
  await api('PUT', '/api/state/todos', [{ text: '给绿萝浇水', done: false }, { text: '交作业', done: false }]);
  await api('PUT', '/api/state/chat', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [{ k: 'me', t: '在吗', ts: Date.now() }] }] });

  console.log('[1] 隔了很久才开口 → 给完整近况');
  plan(['嗯，在的。']);
  const full = await chat('在吗', Date.now() - 3 * 3600000);
  const fullStatus = (full.match(/【现状】[^\n]*/) || [''])[0];
  console.log('      ' + fullStatus.slice(0, 150) + '…');
  ok(/她今天的安排/.test(fullStatus), '有今天的安排');
  ok(/清单上还没完成/.test(fullStatus), '有清单');

  console.log('\n[2] 连着聊（5 分钟前刚说过）→ 只报钟点');
  plan(['嗯嗯。']);
  const brief = await chat('那个…', Date.now() - 5 * 60000);
  const briefStatus = (brief.match(/【现状】[^\n]*/) || [''])[0];
  console.log('      ' + briefStatus);
  ok(!/她今天的安排/.test(briefStatus), '不再重复今天的安排');
  ok(!/清单上还没完成/.test(briefStatus), '不再重复清单');
  /* v2.x 起按她的意思：连着聊的时候纸条一个字都不给（「聊天的时候很少有人会一直注意时间」）*/
  ok(!/现在是 \d{4}\./.test(briefStatus), '连着聊的时候连钟点也不报了（她要的）');
  ok(!/内在状态/.test(briefStatus), '心情那段也不重复');
  console.log(`      省了 ${fullStatus.length - briefStatus.length} 个字，每轮都省`);

  console.log('\n[3] 「在一起第几天」拿掉了');
  ok(!/在一起的第/.test(full) && !/在一起的第/.test(brief), '两档都不再念叨天数');

  console.log('\n[4] 天气：解析逻辑（喂假数据，真接口这边连不上）');
  const fake = {
    current: { temperature_2m: 19.4, apparent_temperature: 21.8, weather_code: 61 },
    daily: { weather_code: [61, 3], temperature_2m_max: [24.1, 17.2], temperature_2m_min: [17.6, 12.4], precipitation_probability_max: [80, 20] },
  };
  const srv = fs.readFileSync(ROOT + '/server.js', 'utf8');
  const fn = srv.slice(srv.indexOf('const WMO_CN'), srv.indexOf('async function checkWeather'));
  const localParts = ms => { const d = new Date((ms == null ? Date.now() : ms) + 8 * 3600000); return { hh: d.getUTCHours(), mm: d.getUTCMinutes() }; };
  const weatherText = new Function('localParts', fn + '; return weatherText;')(localParts);
  const out = weatherText(fake, { city: '长沙' }, Date.now());
  console.log('      ' + out.split('\n').join('\n      '));
  ok(/长沙，此刻 小雨 19℃/.test(out), '此刻天气对');
  ok(/体感 22℃/.test(out), '体感差 2 度以上才显示');
  ok(/今天 小雨，18~24℃，降水概率 80%/.test(out), '今天对');
  ok(/明天 阴，12~17℃/.test(out), '明天对');
  ok(/记得带伞/.test(out) && /明天要降温/.test(out), '顺口的提醒也有了');
})();
