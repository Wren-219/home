const { ROOT, WORK } = require('../lib/env');
/* 她说「五分钟后喊我」—— 他得真的设上、到点真的叫、叫了她真的看得到 */
const fs = require('fs'), B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) C = sc.split(';')[0];
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const chatFile = () => JSON.parse(fs.readFileSync(WORK + '/dat/chat.json', 'utf8'));
const say = async text => (await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
  body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: text }], prevTs: Date.now() - 60000 }) })).text();

(async () => {
  console.log('[时间的各种写法]');
  const src = fs.readFileSync(ROOT + '/server.js', 'utf8');
  const code = src.slice(src.indexOf('const CN_NUM'), src.indexOf('/* ================= 勿扰'));
  const TZ_OFF = 8;
  const localParts = ms => { const d = new Date(ms + TZ_OFF * 3600000); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
  const localStamp = (ms, hh, mm, add = 0) => { const p = localParts(ms); return Date.UTC(p.y, p.mo - 1, p.d + add, hh, mm) - TZ_OFF * 3600000; };
  const parse = new Function('TZ_OFF', 'localStamp', code + '; return parseAlarmAt;')(TZ_OFF, localStamp);
  const now = Date.UTC(2026, 8, 24, 7, 0);   // 北京时间 15:00
  const mins = a => { const t = parse(a, now); return t == null ? null : Math.round((t - now) / 60000); };
  const cases = [['+5', 5], ['5', 5], ['5分钟后', 5], ['五分钟后', 5], ['十五分钟后', 15], ['半小时后', 30], ['一个小时后', 60],
    ['1.5小时后', 90], ['两小时以后', 120], ['+5 minutes', 5], ['in 5 minutes', 5], ['in 2 hours', 120], ['5min', 5],
    ['15:30', 30], ['15:30:00', 30], ['明天 08:00', 17 * 60], ['2026-09-24 15:30', 30], ['2026-09-24T15:30:00+08:00', 30],
    ['2026-09-24T07:30:00Z', 30], ['2026年9月24日 16:00', 60], ['14:00', 23 * 60]];
  const bad = cases.filter(([a, want]) => mins(a) !== want);
  ok(!bad.length, cases.length + ' 种写法都认得' + (bad.length ? '；不认的：' + bad.map(([a, w]) => a + '→' + mins(a) + '(该是' + w + ')').join('，') : ''));
  ok(['下午', '', 'abc', '25:00', '-5', '0分钟后'].every(a => { const t = parse(a, now); return t == null || t <= now; }), '乱写的不认（交给那边回一句「没看懂」）');

  await j('/api/login', 'POST', { pin: '0527' });
  await j('/api/quiet', 'PUT', { classes: '', on: true });
  fs.writeFileSync(WORK + '/dat/alarms.json', '[]');
  fs.writeFileSync(WORK + '/dat/wakelog.json', '{}');
  await j('/api/state/chat', 'PUT', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [{ k: 'me', t: '我眯一会儿', ts: Date.now() - 60000 }] }] });

  console.log('\n[她让他五分钟后喊她]');
  plan([{ tool: 'set_alarm', args: { at: '五分钟后', why: '她说眯一会儿，让我五分钟后喊她', asked: true } }, '好，睡吧，五分钟后叫你。']);
  await say('五分钟后喊我');
  let al = (await j('/api/alarms')).d.list;
  ok(al.length === 1 && al[0].asked === true, '设上了，记着是她让的：' + (al[0] ? al[0].when : '没有'));
  const sent = JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
  const defs = sent.tools.find(t => t.function.name === 'set_alarm');
  ok(defs && defs.function.parameters.properties.asked, '工具说明里告诉了他：她让叫的填 asked');
  ok(sent.messages.some(m => m.role === 'system' && /光嘴上答应，到点是醒不过来的/.test(m.content)), '也告诉了他：光答应不设是醒不过来的');

  console.log('\n[到点了 —— 她一分钟前刚说过话，平常这会儿是不许出声的]');
  const list = JSON.parse(fs.readFileSync(WORK + '/dat/alarms.json', 'utf8'));
  list[0].at = Date.now() - 1000; fs.writeFileSync(WORK + '/dat/alarms.json', JSON.stringify(list));
  plan(['{"say":true,"text":"起来啦，五分钟到了。","again":null}']);
  const w = (await j('/api/wake/test', 'POST', { force: false })).d;
  ok(w.said === true, '叫了：' + JSON.stringify(w).slice(0, 80));
  const wreq = JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
  const last = wreq.messages[wreq.messages.length - 1].content;
  ok(/她亲口让你到点叫她/.test(last) && !/沉默是默认答案/.test(last), '醒来那张纸条说的是「她让你叫她」，不是「沉默是默认」');
  ok(((await j('/api/alarms')).d.today.said || 0) === 0, '不占他一天两次主动开口的名额');

  console.log('\n[她自己没让的，照旧守规矩]');
  fs.writeFileSync(WORK + '/dat/alarms.json', JSON.stringify([{ id: 'x1', at: Date.now() - 1000, why: '想问问她午饭吃了没', win: 'w1', made: Date.now() - 3600000 }]));
  const w2 = (await j('/api/wake/test', 'POST', { force: false })).d;
  ok(w2.skipped === '她刚跟他说过话', '她刚说过话 → 顺延（' + w2.skipped + '）');
  fs.writeFileSync(WORK + '/dat/alarms.json', '[]');

  console.log('\n[叫她的那句，她开着 app 也看得到、存一下也冲不掉]');
  const fresh = (await j('/api/chat/fresh')).d.list;
  ok(fresh.length === 1 && fresh[0].msg.t === '起来啦，五分钟到了。', '新话在「还没交到她手上」的清单里');
  /* 她手上那份是旧的（没有这句），她又说了一句 → 整份存上来 */
  await j('/api/state/chat', 'PUT', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [
    { k: 'me', t: '我眯一会儿', ts: Date.now() - 60000 }, { k: 'me', t: '嗯…再睡一分钟', ts: Date.now() + 1000 }] }] });
  let msgs = chatFile().windows[0].msgs.map(m => m.t);
  ok(msgs.includes('起来啦，五分钟到了。'), '她拿旧的那份一存，他那句还在：' + msgs.join(' / '));
  ok(msgs.indexOf('起来啦，五分钟到了。') < msgs.indexOf('嗯…再睡一分钟'), '按时间排在她那句前面');
  /* 她那边收到了、存上来的时候带着它 → 这件事了结 */
  await j('/api/state/chat', 'PUT', chatFile());
  ok((await j('/api/chat/fresh')).d.list.length === 0, '她那边有了，清单就清空了');
  await j('/api/state/chat', 'PUT', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [{ k: 'me', t: '只留这一句', ts: Date.now() }] }] });
  ok(chatFile().windows[0].msgs.length === 1, '交到之后她再删，就是真删了，不会冒回来');
})();
