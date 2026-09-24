const { chromiumPath } = require('../lib/env');
/* 推送这条路的测试，分三段：
   ① 服务端的接口和数据（用一把真的 P-256 公钥扮成一台设备）
   ② sw.js 收到推送时的行为 —— 用 CDP 直接把 push 事件投给它
   ③ 界面在各种状态下说什么话
   浏览器里真的 subscribe() 在这个容器里做不到：Chrome 的订阅要连 FCM，
   容器出不去网；无痕上下文更是直接禁用 Push API。那一步只能她真机验。 */
const { chromium } = require('playwright-core');
const fs = require('fs'), crypto = require('crypto'), os = require('os'), path = require('path');
const B = 'http://localhost:8081';
let C = '';
const j = async (p, m, b) => {
  const r = await fetch(B + p, { method: m || 'GET', headers: { 'Content-Type': 'application/json', Cookie: C }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return { s: r.status, d: JSON.parse(t) }; } catch { return { s: r.status, d: t }; }
};
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
/* 造一台假设备：一对真的 P-256 密钥 + 16 字节 auth */
function fakeDevice(tag) {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = kp.publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { endpoint: 'http://localhost:8096/push/' + tag,
           p256dh: raw.toString('base64url'), auth: crypto.randomBytes(16).toString('base64url'), ua: tag };
}
(async () => {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0527' }) });
  C = (r.headers.getSetCookie() || []).map(x => x.split(';')[0]).join('; ');

  console.log('[① 服务端]');
  let g = await j('/api/push');
  ok(g.d.count === 0, '一开始没有设备');
  ok(Buffer.from(g.d.key, 'base64url').length === 65, 'VAPID 公钥是 65 字节（界面要拿它去订阅）');
  const key1 = g.d.key;

  const d1 = fakeDevice('iPhone');
  await j('/api/push/sub', 'POST', d1);
  g = await j('/api/push');
  ok(g.d.count === 1, '登记上了');
  ok(g.d.key === key1, 'VAPID 钥匙是长期的，不会每次重生成 —— 不然已订阅的设备全废');
  ok(!/p256dh|"auth"/.test(JSON.stringify(g.d.devices)), '设备列表里不含密钥');

  await j('/api/push/sub', 'POST', d1);
  g = await j('/api/push');
  ok(g.d.count === 1, '同一台重复授权不会变成两条');

  await j('/api/push/sub', 'POST', fakeDevice('iPad'));
  g = await j('/api/push');
  ok(g.d.count === 2, '两台设备都在');

  console.log('\n[真的发一次 —— 假推送服务会检查每一个请求头]');
  let t = await j('/api/push/test', 'POST');
  console.log('      ' + JSON.stringify(t.d).slice(0, 170));
  ok(t.d.sent === 2, '两台都推成了（假服务验过 Authorization / Content-Encoding / TTL 才回 201）');
  ok((t.d.errs || []).length === 0, '没有报错');

  console.log('\n[失败了怎么办 —— 这里栽过一次]');
  await j('/api/push/sub', 'DELETE', {});
  await j('/api/push/sub', 'POST', { ...fakeDevice('gone'), endpoint: 'http://localhost:8096/push/gone' });
  await j('/api/push/sub', 'POST', { ...fakeDevice('missing'), endpoint: 'http://localhost:8096/push/missing' });
  await j('/api/push/sub', 'POST', { ...fakeDevice('boom'), endpoint: 'http://localhost:8096/push/boom' });
  t = await j('/api/push/test', 'POST');
  console.log('      ' + JSON.stringify(t.d).slice(0, 170));
  ok(t.d.gone === 1, '410 Gone 的那台立刻清掉（订阅真的没了）');
  let left = (await j('/api/push')).d;
  ok(left.count === 2, '另外两台还在（' + left.devices.map(x => x.ua).join('/') + '）');

  t = await j('/api/push/test', 'POST');
  left = (await j('/api/push')).d;
  ok(left.count === 2, '404 第二次还是不删 —— 中间代理抽一下风就把她设备踢掉，太狠了');
  t = await j('/api/push/test', 'POST');
  left = (await j('/api/push')).d;
  ok(left.count === 1 && left.devices[0].ua === 'boom', '404 连着三次才当它真没了；500 那台一直留着');
  ok(true, '（500 是服务器自己的毛病，不该算在订阅头上）');
  await j('/api/push/sub', 'DELETE', {});
  await j('/api/push/sub', 'POST', fakeDevice('iPhone'));
  await j('/api/push/sub', 'POST', fakeDevice('iPad'));

  console.log('\n[开关和清理]');
  await j('/api/push', 'PUT', { on: false });
  t = await j('/api/push/test', 'POST');
  ok(/关掉了/.test(t.d.why || ''), '关掉之后一条都不发：' + t.d.why);
  await j('/api/push', 'PUT', { on: true });
  const cur = (await j('/api/push')).d;
  await j('/api/push/sub', 'DELETE', { endpoint: 'http://localhost:8096/push/iPhone' });
  g = await j('/api/push');
  ok(g.d.count === cur.count - 1, '按 endpoint 删掉了一台（' + cur.count + ' → ' + g.d.count + '）');
  await j('/api/push/sub', 'DELETE', {});
  ok((await j('/api/push')).d.count === 0, '不带 endpoint 就是全清');

  console.log('\n[② sw.js 收到推送之后干什么 —— 用 CDP 把事件直接投进去]');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-prof-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: chromiumPath(),
    args: ['--no-sandbox'], viewport: { width: 393, height: 852 },
  });
  await ctx.grantPermissions(['notifications'], { origin: B });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const dd of ['0','5','2','7']) await page.click(`#keypad .key:text-is("${dd}")`);
  await page.waitForTimeout(2000);
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.register('sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    return !!r;
  });
  ok(reg, 'Service Worker 装上了');

  /* 让 sw 把 showNotification 记下来，好知道它到底弹了什么 */
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const sws = await new Promise(res => {
    cdp.on('ServiceWorker.workerVersionUpdated', e => {
      const v = (e.versions || []).find(x => x.status === 'activated' && /sw\.js/.test(x.scriptURL));
      if (v) res(v);
    });
    setTimeout(() => res(null), 6000);
  });
  ok(!!sws, 'CDP 看到它跑起来了' + (sws ? '（registrationId ' + sws.registrationId + '）' : ''));
  if (sws) {
    const payload = JSON.stringify({ title: '晤', body: '睡了吗？都一点了。', url: '/' });
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: B, registrationId: sws.registrationId, data: payload,
    });
    await page.waitForTimeout(1500);
    const notes = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      const ns = await r.getNotifications();
      return ns.map(n => ({ title: n.title, body: n.body, tag: n.tag, icon: n.icon, data: n.data }));
    });
    console.log('      弹出来的：' + JSON.stringify(notes));
    ok(notes.length === 1, '弹了一条');
    ok(notes[0] && notes[0].title === '晤' && /睡了吗/.test(notes[0].body), '标题和正文都是服务器发的那份');
    ok(notes[0] && notes[0].tag === 'wu-message', 'tag 对 —— 连着说几句不会刷屏');
    ok(notes[0] && /icon-180/.test(notes[0].icon || ''), '带上了她画的那个图标');

    /* 再投一条，验证同 tag 会顶掉上一条 */
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: B, registrationId: sws.registrationId,
      data: JSON.stringify({ title: '晤', body: '那早点睡。', url: '/' }),
    });
    await page.waitForTimeout(1200);
    const notes2 = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return (await r.getNotifications()).map(n => n.body);
    });
    ok(notes2.length === 1 && /早点睡/.test(notes2[0]), '第二条把第一条顶掉了，没堆成两条：' + JSON.stringify(notes2));

    /* 坏掉的 payload 不能让它崩 */
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: B, registrationId: sws.registrationId, data: '不是 JSON' });
    await page.waitForTimeout(1200);
    const notes3 = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return (await r.getNotifications()).map(n => ({ t: n.title, b: n.body }));
    });
    ok(notes3.length >= 1, '不是 JSON 也照样弹，不崩：' + JSON.stringify(notes3[0]));
  }

  console.log('\n[③ 界面在各种状态下说什么]');
  await j('/api/push/sub', 'POST', fakeDevice('iPhone'));
  await page.evaluate(() => document.querySelector('.tab[data-page="settings"]').click());
  await page.waitForTimeout(1500);
  ok((await page.locator('#pushBox .per-row').count()) === 1, '设备列出来了');
  ok(/另外 1 台开着/.test(await page.locator('#pushHelp').textContent()),
     '说清了「这台没开、别的开着」：' + (await page.locator('#pushHelp').textContent()).slice(0, 40));
  await page.screenshot({ path: 'ui-推送.png', fullPage: false });

  /* 假装是 Safari 里打开的（非 standalone）—— 该明确告诉她为什么不行 */
  const why = await page.evaluate(() => {
    const real = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', configurable: true });
    const w = pushWhy();
    Object.defineProperty(navigator, 'userAgent', { get: () => real, configurable: true });
    return w;
  });
  ok(/添加到主屏幕/.test(why), 'iPhone 在 Safari 里打开时，说清楚了为什么收不到：' + why.slice(0, 40));

  console.log('\n页面错误：' + (errs.length ? errs.join(' | ') : '无'));
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
})();
