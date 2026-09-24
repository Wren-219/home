const { chromiumPath } = require('../lib/env');
/* 猜密码的限速 + 几个安全头 */
const B = 'http://localhost:8081';
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const login = async (pin, ip) => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) }, body: JSON.stringify({ pin }) });
  let j = {}; try { j = await r.json(); } catch {}
  return { s: r.status, wait: j.wait || 0, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
(async () => {
  console.log('[同一个地方连错 5 次]');
  const r4 = [];
  for (let i = 0; i < 4; i++) r4.push((await login('1111', '1.1.1.1')).s);
  ok(r4.every(s => s === 403), '前 4 次只说「密码不对」');
  const r5 = await login('2222', '1.1.1.1');
  ok(r5.s === 429 && r5.wait > 290 && r5.wait <= 300, '第 5 次就锁了，等 ' + r5.wait + ' 秒（5 分钟）');
  const right = await login('0527', '1.1.1.1');
  ok(right.s === 429, '锁着的时候，输对了也进不去（不然锁了等于没锁）');
  const other = await login('0527', '2.2.2.2');
  const ck = other.cookie;   // 她的手机：登录过，带着 cookie
  ok(other.s === 200, '别的地方不受影响，她照样进得去');

  console.log('\n[输对一次就清零]');
  for (let i = 0; i < 4; i++) await login('3333', '3.3.3.3');
  await login('0527', '3.3.3.3');
  const again = await login('4444', '3.3.3.3');
  ok(again.s === 403, '错 4 次 → 输对 → 再错一次，不会锁（计数清零了）');

  console.log('\n[换着假地址来试 —— 总闸]');
  let locked = null;
  for (let i = 0; i < 40 && !locked; i++) {
    const r = await login(String(1000 + i), '10.0.' + i + '.1');
    if (r.s === 429) locked = i;
  }
  ok(locked !== null && locked < 30, '全部加起来错满 30 次（这回是第 ' + (locked === null ? '—' : locked + 1) + ' 次），总闸落下');
  const g = await login('0527', '9.9.9.9');
  ok(g.s === 429 && g.wait > 1700, '这时候谁都先等半小时（' + Math.round(g.wait / 60) + ' 分钟）');

  console.log('\n[她自己的手机（带着登录过的 cookie）不受总闸影响]');
  const mine = async pin => (await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ pin }) })).status;
  ok(await mine('0527') === 200, '总闸落着，她离开一会儿回来解锁，照样进得去');
  ok(await mine('1234') === 403, '她手滑输错也只是「密码不对」，不算进猜密码里');

  console.log('\n[安全头]');
  const h = await fetch(B + '/');
  ok(h.headers.get('x-frame-options') === 'DENY', '不许别的网站把这里套进框里');
  ok(h.headers.get('x-content-type-options') === 'nosniff', '浏览器不许乱猜文件类型');
  ok(h.headers.get('referrer-policy') === 'no-referrer', '点出去的链接不带这里的地址');
  const hs = await fetch(B + '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
  ok(/max-age=\d+/.test(hs.headers.get('strict-transport-security') || ''), '走 https 的时候，告诉浏览器以后只走 https');

  console.log('\n[锁屏上告诉她要等多久]');
  const { chromium } = require('playwright-core');
  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await b.newContext({ viewport: { width: 393, height: 852 }, isMobile: true })).newPage();
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(800);
  const hint = await page.evaluate(() => document.getElementById('lockHint').textContent);
  ok(/试错太多次了，\d+ 分钟后再试/.test(hint), '「' + hint + '」');
  await b.close();
})();
