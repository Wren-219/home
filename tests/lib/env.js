/* 所有测试共用的几样东西：项目在哪、临时文件放哪、浏览器在哪 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');          // 项目根目录（server.js 所在）
const WORK = path.resolve(__dirname, '..', '.work');        // 测试的临时文件：假数据、假模型的请求记录、截图
const DAT = path.join(WORK, 'dat');                         // 测试用的数据目录（不碰真数据）
fs.mkdirSync(DAT, { recursive: true });

/* 浏览器：优先用环境变量 CHROMIUM；Claude Code 云端环境里预装在 /opt/pw-browsers；
   都没有就交给 playwright-core 自己找（需要先 npx playwright install chromium） */
function chromiumPath() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    const d = fs.readdirSync(base).find(x => /^chromium-/.test(x));
    if (d) { const p = path.join(base, d, 'chrome-linux', 'chrome'); if (fs.existsSync(p)) return p; }
  }
  return undefined;
}
module.exports = { ROOT, WORK, DAT, chromiumPath };
