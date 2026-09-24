const { WORK, chromiumPath } = require('../lib/env');
/* 自动备份：寄到她的收件邮箱、附件是一份不带钥匙的备份、拿它恢复不会清掉现有的钥匙 */
const fs = require('fs'), path = require('path'), B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const mails = () => { const d = path.join(WORK, 'smtp'); return fs.existsSync(d) ? fs.readdirSync(d).sort().map(f => fs.readFileSync(path.join(d, f), 'utf8')) : []; };
/* 从一封 multipart 信里把附件抠出来 */
const attachment = eml => {
  const m = eml.match(/boundary="([^"]+)"/); if (!m) return null;
  const part = eml.split('--' + m[1]).find(x => /Content-Disposition: attachment/.test(x));
  if (!part) return null;
  const name = Buffer.from((part.match(/filename="=\?UTF-8\?B\?([^?]+)\?="/) || [])[1] || '', 'base64').toString() || (part.match(/filename="([^"]+)"/) || [])[1];
  const b64 = part.split('\r\n\r\n').slice(1).join('').replace(/\s+/g, '');
  return { name, body: Buffer.from(b64, 'base64').toString('utf8') };
};
(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');

  console.log('[没配邮箱]');
  let a = (await j('/api/backup/auto')).d;
  ok(a.on && a.every === 15 && !a.mailReady, '默认开着、15 天一次，但还没配邮箱');
  ok((await j('/api/backup/mail', 'POST')).d.ok === false, '现在寄 → 告诉她先去配邮箱');

  console.log('\n[用「写信出去」里填的那个邮箱]');
  await j('/api/mail', 'PUT', { host: 'smtp.fake', port: 465, user: 'me@fake.com', pass: 'good-pass', to: 'her@fake.com' });
  a = (await j('/api/backup/auto')).d;
  ok(a.mailReady && a.dest === 'her@fake.com', '寄到收件地址：' + a.dest);
  const res = (await j('/api/backup/mail', 'POST')).d;
  ok(res.ok, '寄出去了（' + (res.size / 1024).toFixed(1) + ' KB）');
  const eml = mails().pop() || '';
  ok(/^To: <her@fake\.com>/m.test(eml) && /^From: .*<me@fake\.com>/m.test(eml), '从发件邮箱寄到收件邮箱');
  const att = attachment(eml);
  ok(att && /^wu-backup-\d{4}-\d{2}-\d{2}\.json$/.test(att.name), '附件：' + (att && att.name));
  const bak = att ? JSON.parse(att.body) : {};
  ok(bak.app === 'wu-with-you' && bak.noSecrets === true && bak.data.chat, '是一份能恢复的备份，标着「不带钥匙」');
  const raw = att ? att.body : '';
  ok(!/good-pass/.test(raw) && !/sk-test/.test(raw), '里面没有邮箱授权码，也没有 API Key');
  ok(!bak.data.auth && !bak.data.hook && !bak.data.push, '没有密码、快捷指令钥匙、推送私钥');
  ok(bak.data.apis && bak.data.apis.list[0].key === '' && bak.data.mail.user === 'me@fake.com', 'API 配置和邮箱设置都在，只是钥匙空着');
  a = (await j('/api/backup/auto')).d;
  const lastOk = a.last;
  ok(a.last > 0 && a.ok && a.next - a.last === 15 * 86400000, '记下了这次，下次是 15 天后');

  console.log('\n[没填收件地址 → 寄回发件那个邮箱]');
  await j('/api/mail', 'PUT', { to: '' });
  ok((await j('/api/backup/auto')).d.dest === 'me@fake.com', '寄到 me@fake.com');
  await j('/api/mail', 'PUT', { to: 'her@fake.com' });

  console.log('\n[拿邮件里这份恢复]');
  const c = JSON.parse(fs.readFileSync(WORK + '/dat/chat.json', 'utf8'));
  c.windows[0].msgs.push({ k: 'me', t: '备份之后才说的话', ts: Date.now() });
  await j('/api/state/chat', 'PUT', c);
  const rr = (await j('/api/backup', 'POST', bak)).d;
  ok(rr.ok && /不带密码和 Key/.test(rr.note), '恢复了：「' + rr.note + '」');
  const after = JSON.parse(fs.readFileSync(WORK + '/dat/chat.json', 'utf8'));
  ok(!after.windows[0].msgs.some(m => m.t === '备份之后才说的话'), '聊天回到了备份那时候');
  const apis = JSON.parse(fs.readFileSync(WORK + '/dat/apis.json', 'utf8'));
  const mail = JSON.parse(fs.readFileSync(WORK + '/dat/mail.json', 'utf8'));
  ok(apis.list[0].key === 'sk-test' && mail.pass === 'good-pass', 'API Key 和邮箱授权码没被清掉');
  ok((await j('/api/state')).s === 200, '也不用重新输密码');

  console.log('\n[寄不出去的时候]');
  await j('/api/mail', 'PUT', { pass: 'bad-pass' });
  const bad = (await j('/api/backup/mail', 'POST')).d;
  ok(!bad.ok && /535/.test(bad.err), '授权码不对 → 把邮箱那边的原话带回来：' + bad.err.slice(0, 40));
  a = (await j('/api/backup/auto')).d;
  ok(!a.ok && a.last === lastOk && a.err, '记下没寄成，上次成功的时间不变');

  console.log('\n[什么时候寄：每 15 天、晚上十点、失败了第二天晚上再试]');
  const src = fs.readFileSync(require('../lib/env').ROOT + '/server.js', 'utf8');
  const code = src.slice(src.indexOf('let backupBusy = false;'), src.indexOf('/* ================= 她的身体'));
  const H = 3600000, D = 24 * H;
  const when = (hh, st, tried) => {
    let sent = 0;
    const f = new Function('backupAuto', 'mailConf', 'localParts', 'readJson', 'mailBackup', 'Date', code + '; return backupTick;')(
      () => st, () => ({ user: 'me', pass: 'x' }), () => ({ hh }), () => ({ tried: tried || 0 }), async () => { sent++; },
      { now: () => 100 * D });
    return f().then(() => sent);
  };
  const okSt = { on: true, every: 15, last: 100 * D - 15 * D, ok: true };
  ok(await when(22, okSt) === 1, '到了 15 天、晚上 10 点 → 寄');
  ok(await when(14, okSt) === 0, '到了 15 天、但下午两点 → 不寄，等晚上十点');
  ok(await when(3, okSt) === 0, '夜里三点也不寄了（她说不用那么晚）');
  ok(await when(22, { ...okSt, last: 100 * D - 10 * D }) === 0, '才过了 10 天 → 不寄');
  ok(await when(22, { ...okSt, on: false }) === 0, '关着 → 不寄');
  ok(await when(22, { ...okSt, ok: false }, 100 * D - 2 * H) === 0, '刚失败过（两小时前）→ 这一小时别再寄');
  ok(await when(22, { ...okSt, ok: false }, 100 * D - D) === 1, '昨天晚上失败的 → 今天晚上再试');

  console.log('\n[设置页]');
  const { chromium } = require('playwright-core');
  const br = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await br.newContext({ viewport: { width: 393, height: 852 }, isMobile: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('.tab[data-page="settings"]').click());
  await page.waitForTimeout(1500);
  const ui = await page.evaluate(() => ({ on: document.getElementById('swBkAuto').classList.contains('on'), line: document.getElementById('bkAutoLine').textContent }));
  console.log('      ' + ui.line);
  ok(ui.on && /上次没寄成/.test(ui.line) && /寄到 her@fake\.com/.test(ui.line), '开关开着，写着寄到哪、上次没寄成');
  await j('/api/mail', 'PUT', { pass: 'good-pass' });
  await page.evaluate(() => bkMailNow());
  await page.waitForTimeout(1500);
  const line2 = await page.evaluate(() => document.getElementById('bkAutoLine').textContent);
  ok(/上次 \d+ 月 \d+ 日/.test(line2) && /下次大约/.test(line2) && !/没寄成/.test(line2), '点「现在寄一份试试」：' + line2);
  await page.evaluate(() => bkAutoToggle());
  await page.waitForTimeout(600);
  ok((await j('/api/backup/auto')).d.on === false, '能关掉');
  ok(!errs.length, '页面没报错' + (errs.length ? '：' + errs.join(' | ') : ''));
  await br.close();
})();
