const { WORK } = require('../lib/env');
/* 他手里每一件工具都真调一遍：正常参数一轮，缺参数/乱参数一轮。
   看的是：有没有抛异常、有没有把聊天整轮弄崩、回给他的话像不像话 */
const fs = require('fs'), B = 'http://localhost:8081', D = WORK;
const plan = s => fs.writeFileSync(D + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
const GOOD = {
  add_todo: { text: '买柠檬', time: '周六' }, complete_todo: { text: '买柠檬' },
  write_diary: { title: '今天', content: '她发来一张柠檬塔。', weather: '晴' },
  write_letter: { title: '给你', content: '晚安。' }, read_letters: { box: 'ai' }, read_diaries: { limit: 3 },
  list_docs: {}, read_doc: { name: '不存在的文件' }, web_search: { query: '今天天气' }, read_web: { url: 'http://localhost:8081/sw.js' },
  check_period: {}, period_log: { what: 'start' }, send_mail: { subject: '晤', body: '想你了' },
  check_place: { hours: 6 }, check_weather: {}, check_phone: { hours: 3 },
  set_alarm: { at: '+90', why: '她说回家再说' }, cancel_alarm: { why: '回家' },
  remember: { content: '她喜欢柠檬塔', type: '喜好', importance: 3, tags: ['甜点'] },
};
const WEIRD = [{}, { text: null, title: 123, content: ['x'], box: 'zzz', what: 'maybe', at: '明年', url: 'javascript:1', hours: 'abc', limit: -5, name: '../../etc/passwd', query: '', importance: 99, type: '不存在', tags: 'notarray' }];
(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  const C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');
  const logBefore = () => fs.readFileSync(D + '/srv.log', 'utf8').length;
  const say = async () => {
    const x = await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: C },
      body: JSON.stringify({ messages: [{ role: 'user', content: '帮我一下' }] }) });
    return { s: x.status, t: await x.text() };
  };
  const rows = [], bad = [];
  for (const [name, args] of Object.entries(GOOD)) {
    for (const [tag, a] of [['正常', args], ['空参数', WEIRD[0]], ['乱参数', WEIRD[1]]]) {
      const at = logBefore();
      plan([{ tool: name, args: a }, '好']);
      const res = await say();
      const log = fs.readFileSync(D + '/srv.log', 'utf8').slice(at);
      const line = (log.match(new RegExp('\\[tool\\] ' + name + ' .*')) || [''])[0];
      const out = line.split('→ ').slice(1).join('→ ');
      const crashed = res.s !== 200 || /"error"/.test(res.t.slice(0, 300)) || !line;
      const smelly = /TypeError|ReferenceError|undefined|NaN|\[object Object\]|is not a function|Cannot read/.test(out);
      if (tag === '正常') rows.push(name.padEnd(14) + ' → ' + out.slice(0, 64));
      if (crashed || smelly) bad.push(`${name} (${tag})  HTTP ${res.s}  ${line ? '→ ' + out.slice(0, 90) : '日志里没有这次调用'}  ${crashed ? res.t.slice(0, 120) : ''}`);
      if (/Error|at .*\.js:\d+/.test(log.replace(/\[tool\].*/g, ''))) bad.push(`${name} (${tag}) 服务器日志里有报错：` + log.replace(/\[tool\].*/g, '').trim().slice(0, 160));
    }
  }
  console.log('正常参数时他收到的：');
  rows.forEach(x => console.log('  ' + x));
  console.log('');
  console.log((bad.length ? '  XX  ' : '  OK  ') + Object.keys(GOOD).length + ' 件工具 × 正常 / 空参数 / 乱参数，' + (bad.length ? bad.length + ' 处有问题：' : '都没问题'));
  bad.forEach(x => console.log('        ' + x));
})();
