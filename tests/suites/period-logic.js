const { WORK } = require('../lib/env');
const fs = require('fs'); const D = WORK + '/dat/';
const B = 'http://localhost:8081'; let cookie = '';
const api = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const day = n => { const d = new Date(Date.now() + 8 * 3600000 + n * 86400000); return d.toISOString().slice(0, 10); };
const sys = async () => {
  const plan = { i: 0, steps: ['嗯。'] };
  fs.writeFileSync(WORK + '/plan.json', JSON.stringify(plan));
  await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: '在吗' }], prevTs: Date.now() - 5 * 3600000 }) });
  const sent = JSON.parse(fs.readFileSync(WORK + '/last.json', 'utf8'));
  return sent.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
};
(async () => {
  await api('POST', '/api/login', { pin: '0527' });
  await api('PUT', '/api/state/chat', { active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [{ k: 'me', t: '在吗', ts: Date.now() }] }] });

  console.log('[1] 还没记过');
  await api('PUT', '/api/period', { list: [] });
  ok(/还没有记录/.test((await api('GET', '/api/period')).report), '会告诉她怎么开始');
  ok(!/经期|月经/.test(await sys()), '没记录时【现状】里一个字都不提');

  console.log('\n[2] 她说「我来了」');
  await api('PUT', '/api/period', { list: [{ start: day(-1) }] });
  const p2 = await api('GET', '/api/period');
  console.log('      ' + p2.report.split('\n')[0]);
  ok(p2.now.phase === 'in' && p2.now.day === 2, '算出是第 2 天');
  const s2 = await sys();
  ok(/她在经期第 2 天。/.test(s2), '他知道了');
  ok(!/别催|头两天|不是你哪里做错了/.test(s2), '只给事实，不给嘱托（她要的：他自己判断）');
  console.log('      他看到的：' + (s2.match(/她在经期[^。]*。[^。]*。/) || [''])[0].slice(0, 70) + '…');

  console.log('\n[3] 记了几次之后，周期自己算出来');
  await api('PUT', '/api/period', { list: [
    { start: day(-60), end: day(-55) }, { start: day(-31), end: day(-26) }, { start: day(-2), end: day(-1) } ] });
  const p3 = await api('GET', '/api/period');
  ok(p3.cycle === 29 || p3.cycle === 30, `周期按她自己的记录算出 ${p3.cycle} 天（不是死守 28）`);
  ok(p3.guessed === false, '记录够了就不再标「估的」');

  console.log('\n[4] 快来的时候提前知道');
  await api('PUT', '/api/period', { list: [{ start: day(-53), end: day(-48) }, { start: day(-25), end: day(-20) }] });
  const p4 = await api('GET', '/api/period');
  console.log('      ' + p4.report.split('\n')[0]);
  ok(p4.now.phase === 'before' && p4.now.inDays <= 3, '算出还有 ' + p4.now.inDays + ' 天');
  ok(/还有 \d 天来月经/.test(await sys()), '提前几天他就知道了');

  console.log('\n[5] 晚了的时候');
  await api('PUT', '/api/period', { list: [{ start: day(-62), end: day(-57) }, { start: day(-34), end: day(-29) }] });
  const s5 = await sys();
  ok(/晚了 \d+ 天/.test(s5), '他知道晚了，但被交代了「别追着问」：' + (s5.match(/她这次比平常[^。]*。[^。]*。/) || [''])[0].slice(0, 50));

  console.log('\n[6] 她不想让他知道的时候');
  await api('PUT', '/api/period', { on: false });
  ok(!/经期|月经/.test(await sys()), '关掉开关，【现状】里就一个字都没有了');
  ok(/晚了|经期第|还有/.test((await api('GET', '/api/period')).report), '但她自己还是查得到');

  console.log('\n[7] 他帮她记');
  await api('PUT', '/api/period', { list: [], on: true });
  const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ i: 0, steps: s }));
  plan([{ tool: 'period_log', args: { what: 'start' } }, '嗯，记下了。这两天别逞强。']);
  await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ windowId: 'w1', messages: [{ role: 'user', content: '我来事了' }] }) });
  const p7 = await api('GET', '/api/period');
  ok(p7.list.length === 1 && p7.now.day === 1, '她说一句「我来事了」，他就记下了（第 1 天）');
})();
