/* 体检总控。用法：
     node run.js              全部跑一遍，最后出汇总
     node run.js vision       只跑一组，并打印完整输出（名字见下面清单，不用带 .js）
     node run.js --list       列出所有组
   每组开跑前清空假数据、单独起一套服务器和它要的假模型，跑完全部关掉。
   用到的端口：8081 服务器，8085 泄露检查，8096 假推送，8097 加密检查，8098 假 Claude，8099 假模型 */
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), net = require('net');
const { ROOT, WORK, DAT } = require('./lib/env');
const LIB = path.join(__dirname, 'lib'), SUITES = path.join(__dirname, 'suites');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();

const API_M1 = { list: [{ id: 'm1', name: '假模型', base: 'http://localhost:8099', key: 'sk-test', model: 'fake', dialect: 'openai',
  price: { in: 1, out: 2, cacheRead: 0.1, cacheWrite: 1, unit: '￥' } }], chat: 'm1', worker: 'm1' };
const NO_API = { list: [], chat: null, worker: null };
const P4 = { list: [{ start: '2026-06-05', end: '2026-06-10' }, { start: '2026-07-04', end: '2026-07-09' }, { start: '2026-08-02', end: '2026-08-06' }, { start: '2026-08-31', end: '2026-09-04' }], on: true };
const THINK = { i: 0, steps: [{ think: '她问我在不在。这个点她应该刚下课…上次她说今天有实验课，可能会累。别问太多，先应一声。' + '再想想要不要问她吃饭没有。她有时候会忘。'.repeat(3), text: '在呀。\n\n今天怎么样' }, { text: '嗯。' }] };
const OPENAI = ['mock-openai.js'];

/* [分组, 名字, 说明, 要不要起服务器, 预置数据, 要起的假服务] */
const SUITE = [
  ['基础', 'static-lint', '代码扫描（没定义的变量、同名函数互相覆盖…）', false],
  ['基础', 'static-html', '页面静态检查（按钮函数、元素 id、CSS 变量）', false],
  ['基础', 'leak', '数据会不会不登录就被下载', false],
  ['基础', 'push-crypto', '推送加密（浏览器独立解密 + 验签）', false],
  ['巡检', 'sweep-api', '所有接口挨个打，不许 500、不许未登录可读', true, { apis: API_M1 }],
  ['巡检', 'sweep-tools', '他手里每件工具 × 正常/空/乱参数', true, { apis: API_M1 }, OPENAI],
  ['巡检', 'sweep-ui', '每个页面、子页面打开，无害按钮都点', true, { apis: API_M1 }],
  ['界面', 'layout-keyboard', '底部空带、键盘顶导航栏、键盘开着点发送', true, {}],
  ['界面', 'thinking-ui', '思考过程的展开 / 收起', true, { apis: API_M1, plan: THINK }, ['mock-think.js']],
  ['界面', 'vision', '看图：小图、字节不变、开关、只留 12 张', true, { apis: NO_API }, ['mock-claude.js', 'mock-openai-log.js']],
  ['界面', 'period-ui', '「她的身体」页面', true, { period: P4 }],
  ['界面', 'calendar-period', '日历上标经期', true, { period: { ...P4, list: P4.list.slice(1) } }],
  ['界面', 'search-ui', '「上网」设置页', true, {}],
  ['模型', 'claude-dialect', 'Claude 格式：不发 temperature、思考开关', true, { apis: API_M1 }, ['mock-claude.js']],
  ['模型', 'wake-cache', '唤醒和聊天的缓存前缀逐字相同', true, { apis: API_M1 }, ['mock-openai-log.js']],
  ['模型', 'search-api', '上网：三家搜索、读网页、钥匙只进不出', true, {}],
  ['唤醒', 'alarm-hidden', '他偷偷设闹钟，她看不见', true, { apis: API_M1 }, OPENAI],
  ['唤醒', 'wake-budget', '醒了不说话也算钱，一天有上限', true, { apis: API_M1 }, OPENAI],
  ['唤醒', 'night-peek', '夜里她还在玩手机，他可以冒出来', true, { apis: API_M1 }, OPENAI],
  ['唤醒', 'status-note', '【现状】纸条：隔久了给全、连着聊不说', true, { apis: API_M1 }, OPENAI],
  ['联动', 'push', '推送：订阅、失败处理、sw.js 弹通知', true, { apis: API_M1 }, ['fake-push.js', 'mock-think.js']],
  ['联动', 'phone-hook', '快捷指令钥匙、App 打开关闭配对', true, { apis: API_M1 }, OPENAI],
  ['联动', 'phone-close-only', '只配了「关闭」的情况', true, { apis: API_M1 }, OPENAI],
  ['联动', 'phone-cap', '漏了关闭信号，最多按 2 小时算', true, { apis: API_M1 }, OPENAI],
  ['联动', 'phone-foreground', '前台只能有一个 App', true, { apis: API_M1 }, OPENAI],
  ['联动', 'ping-kind', '快捷指令漏填 kind 也认得出', true, { apis: API_M1 }, OPENAI],
  ['联动', 'places', '位置上报', true, { apis: API_M1 }, OPENAI],
  ['联动', 'mcp-server', '接进 Claude 的 MCP 服务端', true, { apis: API_M1 }, OPENAI],
  ['联动', 'period-logic', '经期：算周期、纸条、开关', true, { apis: API_M1 }, OPENAI],
];

const portFree = p => new Promise(r => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p); });
const chat = () => ({ active: 'w1', windows: [{ id: 'w1', name: '晤', msgs: [
  { k: 'me', t: '在吗', ts: t0 - 7200000 }, { k: 'ai', t: '在的。', ts: t0 - 7190000 }] }] });

async function runOne([group, name, desc, needServer, seed = {}, mocks = []], verbose) {
  const kids = [];
  try {
    /* 干净的假数据 */
    fs.rmSync(DAT, { recursive: true, force: true }); fs.mkdirSync(DAT + '/uploads', { recursive: true });
    for (const f of ['plan.json', 'reqs.json', 'areqs.json', 'last.json']) fs.rmSync(path.join(WORK, f), { force: true });
    fs.writeFileSync(DAT + '/chat.json', JSON.stringify(chat()));
    if (seed.apis) fs.writeFileSync(DAT + '/apis.json', JSON.stringify(seed.apis));
    if (seed.period) fs.writeFileSync(DAT + '/period.json', JSON.stringify(seed.period));
    if (seed.plan) fs.writeFileSync(path.join(WORK, 'plan.json'), JSON.stringify(seed.plan));
    for (const m of mocks) kids.push(spawn('node', [path.join(LIB, m)], { stdio: 'ignore' }));
    if (mocks.length) await sleep(600);
    if (needServer) {
      const log = fs.openSync(path.join(WORK, 'srv.log'), 'w');
      kids.push(spawn('node', ['-r', path.join(LIB, 'fakenet.js'), path.join(ROOT, 'server.js')],
        { cwd: WORK, env: { ...process.env, DATA_DIR: DAT, PORT: '8081' }, stdio: ['ignore', log, log] }));
      await sleep(1800);
    }
    const out = await new Promise(res => {
      const p = spawn('node', [path.join(SUITES, name + '.js')], { cwd: WORK }); let o = '';
      p.stdout.on('data', d => { o += d; if (verbose) process.stdout.write(d); });
      p.stderr.on('data', d => { o += d; if (verbose) process.stderr.write(d); });
      const kill = setTimeout(() => { p.kill(); o += '\n（超时）'; }, 150000);
      p.on('close', code => { clearTimeout(kill); res(o + (code ? `\n（退出码 ${code}）` : '')); });
    });
    const okN = (out.match(/^\s+OK /gm) || []).length;
    const xx = out.match(/^\s+XX .*/gm) || [];
    const broke = /（超时）|（退出码 [1-9]/.test(out);
    return { okN, xx, broke, tail: broke ? out.trim().split('\n').filter(l => /Error|超时|退出码/.test(l)).slice(0, 4) : [] };
  } finally {
    kids.forEach(k => k.kill());
    await sleep(300);
  }
}

(async () => {
  const arg = process.argv[2];
  if (arg === '--list') { SUITE.forEach(s => console.log(`${s[0]}  ${s[1].padEnd(17)} ${s[2]}`)); return; }
  const pick = arg ? SUITE.filter(s => s[1] === arg.replace(/\.js$/, '')) : SUITE;
  if (!pick.length) { console.log('没有叫「' + arg + '」的，用 --list 看清单'); process.exit(1); }
  for (const p of [8081, 8085, 8096, 8097, 8098, 8099]) if (!(await portFree(p))) {
    console.log(`端口 ${p} 被占着 —— 先把占着它的进程停掉（可能是上次没跑完的测试）`); process.exit(1);
  }
  const lines = []; let fail = 0, total = 0;
  for (const s of pick) {
    const r = await runOne(s, !!arg);
    total += r.okN;
    const bad = r.xx.length || r.broke;
    if (bad) fail++;
    const line = `${bad ? '✗' : '✓'} ${s[0]}  ${s[1].padEnd(17)} ${String(r.okN).padStart(3)} 过${r.xx.length ? ' / ' + r.xx.length + ' 挂' : ''}${r.broke ? '  崩了' : ''}   ${s[2]}`;
    lines.push(line, ...r.xx.map(x => '      ' + x.trim()), ...r.tail.map(x => '      ' + x.trim()));
    if (!arg) console.log(line);
  }
  console.log('\n==== 汇总 ====\n' + lines.join('\n'));
  console.log(`\n${pick.length} 组，${total} 条检查，${fail ? fail + ' 组有问题' : '全部通过'}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
  process.exit(fail ? 1 : 0);
})();
