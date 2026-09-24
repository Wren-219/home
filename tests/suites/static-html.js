/* 页面这一层的静态检查：按钮调的函数在不在、找的元素在不在、CSS 变量有没有定义、id 有没有重复 */
const { ROOT } = require('../lib/env');
const fs = require('fs');
for (const f of ['index.html', 'admin.html']) {
  const h = fs.readFileSync(ROOT + '/' + f, 'utf8');
  const js = [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const markup = h.replace(/<script>[\s\S]*?<\/script>/g, '');
  const defined = new Set([
    ...[...js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]),
    ...[...js.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]),
    ...[...js.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]),
  ]);
  const builtin = new Set(['this', 'event', 'document', 'window', 'location', 'history', 'alert', 'confirm', 'setTimeout', 'if', 'return']);
  /* ① 行内事件（包括 JS 模板字符串里拼出来的）调的函数得存在 */
  const missing = new Set();
  for (const m of h.matchAll(/on(?:click|change|input|submit|keydown|focus|blur|load|error)\s*=\s*"([^"]*)"/g)) {
    for (const c of m[1].matchAll(/(?:^|[;\s(!&|])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const n = c[1];
      if (!defined.has(n) && !builtin.has(n)) missing.add(n + '  ←  ' + m[1].slice(0, 60));
    }
  }
  /* ② getElementById / querySelector('#x') 找的 id 得在页面上（或者在 JS 里被造出来） */
  const ids = new Set([...h.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const dynIds = new Set([...js.matchAll(/\.id\s*=\s*["'`]([^"'`$]+)["'`]/g)].map(m => m[1]));
  const lost = new Set();
  for (const m of js.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) if (!ids.has(m[1]) && !dynIds.has(m[1])) lost.add(m[1]);
  for (const m of js.matchAll(/querySelector(?:All)?\(\s*["']#([\w-]+)/g)) if (!ids.has(m[1]) && !dynIds.has(m[1])) lost.add('#' + m[1]);
  /* ③ 用到的 CSS 变量得有定义 */
  const cssDef = new Set([...h.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  const cssUse = new Set([...h.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]));
  const js2 = [...js.matchAll(/setProperty\(\s*["'](--[\w-]+)/g)].map(m => m[1]); js2.forEach(v => cssDef.add(v));
  const noVar = [...cssUse].filter(v => !cssDef.has(v));
  /* ④ 重复的 id */
  const idCount = {}; for (const m of markup.matchAll(/\sid="([^"]+)"/g)) idCount[m[1]] = (idCount[m[1]] || 0) + 1;
  const dup = Object.entries(idCount).filter(([, n]) => n > 1).map(([k, n]) => k + '×' + n);

  const say = (bad, label, list) => console.log((bad ? '  XX  ' : '  OK  ') + f + ' ' + label + (bad ? '：' + list : ''));
  say(missing.size, '按钮调的函数都存在', [...missing].join(' | '));
  say(lost.size, '代码里找的元素 id 都在', [...lost].join(', '));
  say(noVar.length, 'CSS 变量都有定义', noVar.join(', '));
  say(dup.length, '没有重复的 id', dup.join(', '));
}
