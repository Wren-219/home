/* 数据目录放在项目目录里面（跟 Zeabur 上的 /app + /app/data 一样），
   看有没有东西不用登录就能下载。把项目复制一份到临时目录里测，不碰真数据。 */
const { spawn } = require('child_process'); const fs = require('fs'), path = require('path');
const { ROOT, WORK } = require('../lib/env');
const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);
const APP = path.join(WORK, 'app'), PORT = 8085;
(async () => {
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP + '/data/uploads', { recursive: true });
  for (const f of ['server.js', 'index.html', 'admin.html', 'sw.js', 'icon-180.png', 'icon-512.png', 'HANDOFF.md', 'package.json'])
    if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
  fs.mkdirSync(APP + '/.git'); fs.writeFileSync(APP + '/.git/config', '[core]');
  for (const f of ['apis', 'auth', 'mail', 'push', 'chat']) fs.writeFileSync(`${APP}/data/${f}.json`, '{"secret":"x"}');
  fs.writeFileSync(APP + '/data/uploads/zz.jpg', 'x');
  const srv = spawn('node', ['server.js'], { cwd: APP, env: { ...process.env, PORT: String(PORT), DATA_DIR: APP + '/data' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1500));
  const st = async p => (await fetch('http://localhost:' + PORT + p)).status;
  try {
    for (const p of ['/data/apis.json', '/data/auth.json', '/data/mail.json', '/data/push.json', '/data/chat.json',
                     '/data/uploads/zz.jpg', '/data/%2e%2e/server.js', '/server.js', '/HANDOFF.md', '/.git/config', '/package.json'])
      ok(await st(p) === 404, p + ' 不用登录拿不到');
    for (const p of ['/', '/admin', '/sw.js', '/icon-180.png', '/icon-512.png']) ok(await st(p) === 200, p + ' 照常能打开');
    ok(await st('/files/zz.jpg') === 401, '/files/ 下的照片要登录');
  } finally { srv.kill(); fs.rmSync(APP, { recursive: true, force: true }); }
})();
