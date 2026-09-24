const { WORK } = require('../lib/env');
/* 唤醒这条路的测试。最要紧的一条：唤醒请求和随后聊天请求的前缀是不是逐字一样 */
const fs = require('fs'), B = 'http://localhost:8081';
const D = WORK;
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(D + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const reqs = () => fs.existsSync(D + '/reqs.json') ? JSON.parse(fs.readFileSync(D + '/reqs.json', 'utf8')) : [];
const clearReqs = () => fs.existsSync(D + '/reqs.json') && fs.unlinkSync(D + '/reqs.json');

(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');

  /* 模拟前端：历史存在 chat.json 里，前端每次把整段带上来 */
  const hist = () => {
    const c = JSON.parse(fs.readFileSync(D + '/dat/chat.json', 'utf8'));
    const w = c.windows.find(x => x.id === c.active) || c.windows[0];
    return w.msgs.map(m => ({ role: m.k === 'ai' ? 'assistant' : 'user', content: m.t }));
  };
  const say = async (text) => {
    const res = await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
      body: JSON.stringify({ messages: [...hist(), { role: 'user', content: text }], prevTs: Date.now() - 60000 }) });
    return await res.text();
  };
  console.log('[先聊一句，垫起历史]');
  plan(['嗯，我在。']);
  const t0 = await say('我回家再和你说');
  ok(!/error/.test(t0.slice(0, 80)), '聊过一轮了');

  clearReqs();
  console.log('\n[他记下一个时刻，然后到点醒来]');
  plan([{ say: true, text: '到家了吗', again: null }]);
  let w = await j('/api/wake/test', 'POST', { why: '她说回家再说' });
  console.log('      结果：' + JSON.stringify(w.d).slice(0, 80));
  ok(w.d.said === true, '他开口了');
  const wakeReq = reqs()[reqs().length - 1];

  console.log('\n[她回他一句 —— 这就是她最在意的那次]');
  plan(['那我等你。']);
  await say('到啦');
  const chatReq = reqs()[reqs().length - 1];

  console.log('\n[比对前缀 —— tools → system → messages]');
  ok(JSON.stringify(wakeReq.tools) === JSON.stringify(chatReq.tools),
    '① 工具清单逐字一样（唤醒 ' + (wakeReq.tools || []).length + ' 件 / 聊天 ' + (chatReq.tools || []).length + ' 件）');
  ok(wakeReq.tool_choice === chatReq.tool_choice, '② tool_choice 两边都没设（' + wakeReq.tool_choice + '）');

  const pre = (req, n) => JSON.stringify((req.messages || []).slice(0, n));
  let same = 0;
  const a = wakeReq.messages || [], b2 = chatReq.messages || [];
  while (same < a.length && same < b2.length && JSON.stringify(a[same]) === JSON.stringify(b2[same])) same++;
  console.log('      唤醒 ' + a.length + ' 条 / 聊天 ' + b2.length + ' 条，从头逐字相同的有 ' + same + ' 条');
  console.log('      第一条不同的是：唤醒[' + same + ']=' + JSON.stringify(a[same] || null).slice(0, 70));
  console.log('                       聊天[' + same + ']=' + JSON.stringify(b2[same] || null).slice(0, 70));
  /* 理论上限就是「人设 + 工具说明 + 唤醒当时的全部历史」——
     再往后聊天多了他刚说的那句，必然分叉。能到这个数就是一个字都没浪费 */
  const histLen = a.length - 4;   // 减掉开头两条 system，和末尾的 volatile + 唤醒提示
  ok(same === 2 + histLen, '③ 公共前缀吃满了：人设 + 工具说明 + 全部 ' + histLen + ' 条历史（' + same + ' 条）');
  ok(JSON.stringify(a.slice(0, 2)) === JSON.stringify(b2.slice(0, 2)), '④ 人设和工具说明一模一样');
  ok(a[a.length - 1].role === 'user' && /这不是她发来的消息/.test(a[a.length - 1].content),
    '⑤ 唤醒那段提示确实在最后一条，前面什么都没动');
  ok(a[a.length - 2].wuVolatile === undefined && /【现状】|【你的记忆】/.test(a[a.length - 2].content),
    '⑥ 记忆和现状那块也在历史之后');

  console.log('\n[醒来之后他能不能先查一眼再决定]');
  clearReqs();
  plan([{ tool: 'check_phone', args: { hours: 3 } }, { say: true, text: '还在刷呢？', again: null }]);
  w = await j('/api/wake/test', 'POST', { why: '她说十一点睡' });
  console.log('      结果：' + JSON.stringify(w.d).slice(0, 70));
  ok(w.d.said === true && /还在刷/.test(w.d.text || ''), '他先查了手机，再开的口');
  const rr = reqs();
  ok(rr.length === 2, '为此多打了一轮（共 ' + rr.length + ' 次请求）');
  ok(JSON.stringify(rr[0].tools) === JSON.stringify(rr[1].tools), '两轮之间工具清单也没变');
  const last = rr[1].messages;
  ok(last.some(m => m.role === 'tool'), '工具结果喂回去了');
  ok(JSON.stringify(rr[0].messages) === JSON.stringify(last.slice(0, rr[0].messages.length)), '第二轮是在第一轮后面接着长的（前缀没动）');

  console.log('\n[他要是一直想查，不能没完没了]');
  clearReqs();
  plan([{ tool: 'check_phone', args: {} }, { tool: 'check_weather', args: {} }, { tool: 'check_phone', args: {} }, { tool: 'check_phone', args: {} }]);
  w = await j('/api/wake/test', 'POST', { why: '测试' });
  ok(reqs().length <= 3, '最多查两轮就收手（打了 ' + reqs().length + ' 次）');
  ok(w.d.ok === true, '就算他没给出 JSON，也不算崩：' + JSON.stringify(w.d).slice(0, 60));
  console.log('\n完');
})();
