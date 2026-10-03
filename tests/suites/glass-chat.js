const { chromiumPath, WORK } = require('../lib/env');
/* 新界面（液态玻璃）聊天页：右滑消息代替长按
   · 我的话右滑 = 改了重发（同一条消息飞上去，宽高不变）；删空再发 = 删掉
   · 他的话右滑 = 复制 / 选字 / 重说 / 删掉 + 时间（12 小时制）
   · 拉不够就弹回去；点空白处退出；设置里能切回原来的样子 */
const fs = require('fs');
const B = 'http://localhost:8081';
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const plan = s => fs.writeFileSync(WORK + '/plan.json', JSON.stringify({ steps: s, i: 0 }));
(async () => {
  const { chromium } = require('playwright-core');
  const br = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await br.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true })).newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(B, { waitUntil: 'networkidle' });
  for (const d of ['0', '5', '2', '7']) await page.click(`#keypad .key:text-is("${d}")`);
  await page.waitForTimeout(1500);
  await page.click('.tab[data-page="chat"]');
  await page.waitForTimeout(800);
  /* 学手指往右拉：按下 → 一点点挪 → 抬起 */
  async function swipe(sel, dist) {
    const bb = await page.locator(sel).boundingBox(); const x = bb.x + 20, y = bb.y + bb.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let k = 1; k <= 12; k++) { await page.mouse.move(x + dist * k / 12, y + 1); await page.waitForTimeout(16); }
    await page.mouse.up(); await page.waitForTimeout(650);
  }
  const blank = async () => { await page.mouse.click(200, 200); await page.waitForTimeout(600); };

  console.log('[默认就是新界面]');
  const g = await page.evaluate(() => {
    const bubs = [...document.querySelectorAll('#chatMsgs .bub')];
    const plus = document.getElementById('plusBtn').getBoundingClientRect(), inp = document.getElementById('chatInput').getBoundingClientRect();
    return { on: document.documentElement.classList.contains('ui-glass'), tails: bubs.filter(b => b.classList.contains('g-tail')).length, n: bubs.length,
      mask: bubs.every(b => !b.classList.contains('g-tail') || /svg/.test(b.style.webkitMaskImage || b.style.maskImage)),
      plusLeft: plus.right <= inp.left, sameRow: Math.abs(plus.bottom - inp.bottom) < 12, wall: !!getComputedStyle(document.getElementById('frame')).getPropertyValue('--g-wall') };
  });
  ok(g.on, '默认打开新界面');
  ok(g.tails === g.n && g.mask, '一问一答各自是一串的最后一条，都长了尾巴（气泡连尾巴是一整块遮罩）');
  ok(g.plusLeft && g.sameRow, '输入栏是 iMessage 的排法：＋ 在左边，跟输入框一排');
  ok(g.wall, '垫了一张默认壁纸');
  await page.screenshot({ path: 'ui-新界面聊天.png' });

  console.log('\n[拉不够就弹回去]');
  await swipe('#chatMsgs .bub.ai', 30);
  ok(await page.evaluate(() => gFocusI < 0 && gEditI < 0 && !document.getElementById('gDim').classList.contains('on')), '拉 30px 松手：什么都没开');

  console.log('\n[右拉他的话]');
  await swipe('#chatMsgs .bub.ai', 120);
  const f = await page.evaluate(() => ({
    on: document.getElementById('gFocus').classList.contains('on'), soft: document.getElementById('gDim').classList.contains('soft'),
    acts: [...document.querySelectorAll('#gFocus .g-acts button')].map(b => b.dataset.a).join(),
    t: document.querySelector('#gFocus .g-mt').textContent, lifted: !!document.querySelector('#gFocus .bub.g-lift'),
    menuTop: document.querySelector('#gFocus .g-menu').getBoundingClientRect().top, bubBottom: document.querySelector('#gFocus .bub').getBoundingClientRect().bottom,
  }));
  ok(f.on && f.lifted, '那条被拉出来浮着');
  ok(f.soft, '周围只是轻轻变暗（其他消息的字看得清）');
  ok(f.acts === 'copy,sel,regen,del', '底下一排：复制 / 选字 / 重说 / 删掉');
  ok(/^\d+月\d+日 (上午|下午)\d+:\d\d$/.test(f.t), '时间在右边，12 小时制：' + f.t);
  ok(f.menuTop - f.bubBottom < 14, '按钮紧贴着消息（隔 ' + Math.round(f.menuTop - f.bubBottom) + 'px）');
  await page.screenshot({ path: 'ui-新界面拉他的话.png' });
  await blank();
  ok(await page.evaluate(() => gFocusI < 0 && !document.getElementById('gDim').classList.contains('on') && !document.getElementById('gFocus').classList.contains('on')), '点空白处退出');
  ok(await page.evaluate(() => [...document.querySelectorAll('#chatMsgs .bub')].every(b => b.style.visibility !== 'hidden' && !b.style.transform)), '原来那条回到原处');

  console.log('\n[右拉我的话]');
  const before = await page.evaluate(() => { const r = document.querySelector('#chatMsgs .bub.me').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  await swipe('#chatMsgs .bub.me', 120);
  const e = await page.evaluate(() => {
    const fly = document.querySelector('#gEdit .bub'), r = fly.getBoundingClientRect();
    return { on: document.getElementById('gEdit').classList.contains('on'), val: document.getElementById('gEtxt').value, focus: document.activeElement.id,
      w: Math.round(r.width), h: Math.round(r.height), t: document.getElementById('gEtime').textContent, kb: document.body.classList.contains('kb-open'),
      flyBottom: r.bottom, formTop: document.getElementById('gEform').getBoundingClientRect().top };
  });
  ok(e.on && e.val === '在吗', '输入框里是原句：「' + e.val + '」');
  ok(e.focus === 'gEtxt' && e.kb, '光标在输入框里（手机上键盘就弹出来了）');
  ok(e.w === before.w && e.h === before.h, '飞上去的还是那一条，宽高一点没变（' + e.w + '×' + e.h + '），不会一行变两行');
  ok(e.flyBottom < e.formTop, '原句停在输入框上面，给你对照');
  ok(/(上午|下午)/.test(e.t), '时间从上面滑下来：' + e.t);
  await page.screenshot({ path: 'ui-新界面改我的话.png' });
  await blank();
  ok(await page.evaluate(() => gEditI < 0 && !document.getElementById('gDim').classList.contains('on')), '点空白处退出，不改了');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => !document.querySelector('#gEdit .bub') && document.querySelector('#chatMsgs .bub.me').style.visibility !== 'hidden'), '那条飞回原处');

  console.log('\n[改了重发]');
  plan(['改过之后我听懂了。']);
  await swipe('#chatMsgs .bub.me', 120);
  await page.fill('#gEtxt', '在吗在吗');
  await page.click('#gEsend');
  await page.waitForTimeout(2500);
  const log1 = await page.evaluate(() => chatLog.map(m => m.k + ':' + m.t));
  ok(log1.join(' | ') === 'me:在吗在吗 | ai:改过之后我听懂了。', '这句换掉、后面的收走，他重新回：' + log1.join(' | '));

  console.log('\n[让他重说]');
  plan(['再说一遍：我在。']);
  await swipe('#chatMsgs .bub.ai', 120);
  await page.click('#gFocus [data-a=regen]');
  await page.waitForTimeout(2500);
  const log2 = await page.evaluate(() => chatLog.map(m => m.k + ':' + m.t));
  ok(log2.join(' | ') === 'me:在吗在吗 | ai:再说一遍：我在。', '他那条重说了：' + log2.join(' | '));

  console.log('\n[删掉]');
  await swipe('#chatMsgs .bub.ai', 120);
  await page.click('#gFocus [data-a=del]');
  await page.waitForTimeout(700);
  ok((await page.evaluate(() => chatLog.map(m => m.k).join())) === 'me', '他那条删掉了');
  await swipe('#chatMsgs .bub.me', 120);
  await page.fill('#gEtxt', '');
  await page.dispatchEvent('#gEtxt', 'input');
  ok(await page.evaluate(() => document.getElementById('gEsend').classList.contains('del')), '把字删空，发送键变成红色垃圾桶');
  await page.click('#gEsend');
  await page.waitForTimeout(700);
  ok((await page.evaluate(() => chatLog.length)) === 0, '点一下就删掉了这句，他也没有重新回');

  console.log('\n[设置里切回原来的样子]');
  await page.evaluate(() => { appendMsg({ k: 'me', t: '还在吗' }); appendMsg({ k: 'ai', t: '在。' }); });
  await page.waitForTimeout(300);
  await page.evaluate(() => uiToggle());
  await page.waitForTimeout(400);
  const o = await page.evaluate(() => ({ on: document.documentElement.classList.contains('ui-glass'), tails: document.querySelectorAll('#chatMsgs .g-tail').length,
    saved: localStorage.getItem('wu.ui') }));
  ok(!o.on && o.tails === 0 && o.saved === 'old', '关掉：回到原来的样子，尾巴都摘了，记住了');
  await page.dispatchEvent('#chatMsgs .bub.ai', 'contextmenu');
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => document.getElementById('msgSheet').classList.contains('open')), '原来的长按菜单回来了');
  await page.evaluate(() => closeMsgSheet());
  await page.reload({ waitUntil: 'networkidle' });
  ok(!(await page.evaluate(() => document.documentElement.classList.contains('ui-glass'))), '刷新之后还是原来的样子');
  await page.goto(B + '/?ui=glass', { waitUntil: 'networkidle' });
  ok(await page.evaluate(() => document.documentElement.classList.contains('ui-glass')), '网址加 ?ui=glass 又换回新界面');

  ok(errs.length === 0, '页面没有报错' + (errs.length ? '：' + errs.join(' / ') : ''));
  await br.close();
})();
