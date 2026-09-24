const { ROOT, WORK } = require('../lib/env');
/* 聊得很长以后，缓存还接不接得上；记忆系统断开以后，是不是真的一点都不往聊天里塞 */
const fs = require('fs'), B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const reqs = () => fs.existsSync(WORK + '/reqs.json') ? JSON.parse(fs.readFileSync(WORK + '/reqs.json', 'utf8')) : [];
const clr = () => fs.rmSync(WORK + '/reqs.json', { force: true });
const send = async msgs => (await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
  body: JSON.stringify({ windowId: 'w1', messages: msgs, prevTs: Date.now() - 60000 }) })).text();
/* 历史部分：去掉前面的人设、工具说明，和最后那张纸条 + 她最新那句 */
const histOf = req => req.messages.filter(x => x.role !== 'system').slice(0, -1);

(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');

  console.log('[聊得超过额度以后]');
  /* 每句一百来个字，400 句 ≈ 四万多 token，超过 3 万的额度 */
  const line = i => '第' + i + '句。' + '今天在图书馆坐了一下午，窗外一直在下雨，我把那本书看完了，结尾有点难过，但也挺好的。'.repeat(2);
  const H = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: line(i) }));
  const firsts = [], prefixSame = [];
  let broken = 0;
  let prev = null, msgs = H.slice();
  for (let t = 0; t < 6; t++) {
    clr(); plan(['嗯，我在听。']);
    msgs = msgs.concat([{ role: 'user', content: '然后呢' + t }]);
    await send(msgs);
    const h = histOf(reqs()[0]);
    firsts.push(h[0].content.slice(0, 6));
    if (prev) prefixSame.push(JSON.stringify(h.slice(0, prev.length)) === JSON.stringify(prev));
    if (h.some(m => m.content.includes('\uFFFD'))) broken++;
    prev = h;
    msgs = msgs.concat([{ role: 'assistant', content: '嗯，我在听。' }]);
  }
  /* 请求一过 64KB 就分块到。以前服务器每块各自解码，块的边界切在汉字中间，那个字就坏成「��」 */
  ok(broken === 0, '6 轮、每轮一百多 KB，没有一个字坏掉' + (broken ? '（' + broken + ' 轮里有坏字）' : ''));
  ok(new Set(firsts).size === 1, '连着聊 6 轮，历史的开头一直是同一句：' + firsts[0] + '（以前每轮挤掉一句）');
  ok(prefixSame.every(Boolean), '每一轮的历史，都是上一轮原样 + 后面新加的（缓存接得上）');
  const kept = prev.reduce((n, m) => n + m.content.length, 0);
  ok(kept < 30000 && kept > 12000, '留下的没超额度，也没砍得太狠（约 ' + kept + ' 字）');

  console.log('\n[请求分几块到的时候，汉字不能被切坏]');
  /* 手机隔着网络发一大段过来，一定是分好几块到的。故意把一个汉字切成两半、分两次发 */
  const body = Buffer.from(JSON.stringify({ active: 'w1', windows: [{ id: 'w1', name: '日常', msgs: [{ k: 'me', t: '栀子花开了，好香', ts: 1 }] }] }));
  const at = body.indexOf(Buffer.from('栀')) + 1;   // 「栀」三个字节，切在第一个字节后面
  await new Promise((res, rej) => {
    const q = require('http').request(B + '/api/state/chat', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: C, 'Content-Length': body.length } }, r => { r.resume(); r.on('end', res); });
    q.on('error', rej);
    q.write(body.subarray(0, at));
    setTimeout(() => q.end(body.subarray(at)), 150);
  });
  const got = JSON.parse(fs.readFileSync(WORK + '/dat/chat.json', 'utf8')).windows[0].msgs[0].t;
  ok(got === '栀子花开了，好香', '切成两半发过去，存下来的还是「' + got + '」');

  console.log('\n[前端和服务器，超过 600 条时从第几条开始送 —— 规则一样]');
  const src = fs.readFileSync(ROOT + '/server.js', 'utf8'), html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const histFrom = new Function(src.match(/function histFrom\(len\) \{[^\n]*\}/)[0] + '; return histFrom;')();
  const fe = html.match(/const from = (chatLog\.length <= 600 \? 0 : [^;]+);/)[1];
  const feFrom = new Function('chatLog', 'return ' + fe + ';');
  let diff = 0, moves = 0;
  for (let n = 0; n <= 3000; n++) {
    if (histFrom(n) !== feFrom({ length: n })) diff++;
    if (n && histFrom(n) !== histFrom(n - 1)) moves++;
  }
  ok(diff === 0, '0 到 3000 条，两边算出来的都一样');
  ok(moves === 13, '3000 条里开头只挪了 ' + moves + ' 次（以前 600 条之后每条都挪）');
  ok(histFrom(601) === 200 && 601 - histFrom(601) >= 400 && 799 - histFrom(799) <= 600, '每次送 400～600 条');

  console.log('\n[记忆：默认跟聊天断开]');
  await j('/api/memories', 'POST', { content: '她最喜欢栀子花的味道', type: '喜好', importance: 5, tags: ['栀子花'] });
  ok((await j('/api/memconf')).d.auto === false, '开关默认是关的');
  clr(); plan(['嗯。']);
  await send([{ role: 'user', content: '楼下的栀子花开了' }]);
  let rq = reqs()[0];
  ok(!rq.messages.some(m => /【你的记忆】/.test(m.content)), '记忆卡没有塞给他');
  ok(!rq.tools.some(t => t.function.name === 'remember'), '屋里不给他 remember');
  ok(!rq.messages.some(m => m.role === 'system' && /记住重要的事/.test(m.content)), '工具说明里也不提「记住重要的事」');
  ok(!fs.existsSync(WORK + '/dat/distill_buf.json'), '聊天内容没有进蒸馏');
  ok((await j('/api/memories')).d.some(c => /栀子花/.test(c.content)), '记忆页里的卡片还在');

  console.log('\n[打开之后，照旧]');
  await j('/api/memconf', 'PUT', { auto: true });
  clr(); plan(['嗯。']);
  await send([{ role: 'user', content: '楼下的栀子花开了' }]);
  rq = reqs()[0];
  ok(rq.messages.some(m => /【你的记忆】[\s\S]*栀子花/.test(m.content)), '记忆卡带上了');
  ok(rq.tools.some(t => t.function.name === 'remember'), 'remember 回来了');
  ok(fs.existsSync(WORK + '/dat/distill_buf.json'), '聊天内容进了蒸馏队列');
  await j('/api/memconf', 'PUT', { auto: false });
})();
