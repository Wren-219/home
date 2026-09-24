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
const H = 3600000;

(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  const tok = (await api('GET', '/api/hook')).j.token;
  console.log('钥匙:', tok);

  console.log('\n[1] 钥匙不对就不收');
  ok((await api('POST', '/api/ping', { token: 'wrong', kind: 'open', app: '小红书' })).s === 401, '假钥匙被挡回 401');
  ok((await api('POST', '/api/ping', { token: tok, kind: 'open', app: '小红书' })).s === 200, '真钥匙收下了');

  console.log('\n[2] 打开 / 关闭配成一段，算得出用了多久');
  const now = Date.now();
  fs.writeFileSync(D + 'phone.json', JSON.stringify({ events: [
    { t: now - 3 * H, app: '小红书', k: 'open' }, { t: now - 3 * H + 35 * 60000, app: '小红书', k: 'close' },
    { t: now - 2 * H, app: '微信', k: 'open' },   { t: now - 2 * H + 5 * 60000, app: '微信', k: 'close' },
    { t: now - 1 * H, app: '小红书', k: 'open' }, { t: now - 1 * H + 20 * 60000, app: '小红书', k: 'close' },
    { t: now - 12 * 60000, app: '小红书', k: 'open' },   // 还开着
  ] }));
  const r = (await api('GET', '/api/phone?hours=24')).j;
  console.log('      ' + r.report.split('\n').join('\n      '));
  ok(/小红书：3 次，共 1 小时 7 分/.test(r.report), '小红书 35+20+12=67 分，算对了');
  ok(/这会儿还开着/.test(r.report) && /她此刻正开着/.test(r.report), '抓到现行：这会儿正开着');

  console.log('\n[3] 只留三天');
  fs.writeFileSync(D + 'phone.json', JSON.stringify({ events: [
    { t: now - 5 * 86400000, app: '五天前的', k: 'open' },
    { t: now - 1 * 86400000, app: '昨天的', k: 'open' },
  ] }));
  const h = (await api('GET', '/api/hook')).j;
  ok(h.events === 1, `五天前那条自己没了（剩 ${h.events} 条）`);

  console.log('\n[4] 日程：快捷指令送一段文本过来');
  await api('POST', '/api/ping', { token: tok, kind: 'agenda',
    text: '09:00 高等数学 教三301\n14:00 见导师\n19:30 社团例会' });
  const hk = (await api('GET', '/api/hook')).j;
  ok(hk.agenda === 3, `收到 ${hk.agenda} 条日程`);

  console.log('\n[5] 日程进了他每轮都能看到的【现状】');
  await api('PUT', '/api/state/chat', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [{ k: 'me', t: '在吗', ts: Date.now() }] }] });
  plan(['嗯，在的。']);
  await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: '在吗' }] }) });
  const sent = JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
  const sys = sent.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  ok(/她今天的安排：.*高等数学.*见导师/.test(sys), '【现状】里有今天的安排');
  ok(!/小红书/.test(sys), '手机记录没有塞进每轮上下文（那是工具，按需查）');

  console.log('\n[6] 他用工具查手机');
  fs.writeFileSync(D + 'phone.json', JSON.stringify({ events: [
    { t: now - 40 * 60000, app: '小红书', k: 'open' },
  ] }));
  plan([{ tool: 'check_phone', args: { hours: 12 } }, '这么晚还在刷小红书？']);
  const sse = await (await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: '我在学习呢' }] }) })).text();
  const shown = sse.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map(l => { try { return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
  const sent2 = JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
  const toolResult = sent2.messages.filter(m => m.role === 'tool').map(m => m.content).join('');
  ok(/小红书/.test(toolResult), '工具查到了：' + toolResult.split('\n')[1]);
  ok(shown.includes('小红书'), '他当场抓包：「' + shown + '」');
})();
