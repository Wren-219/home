/* 代码扫描：用了没定义的变量、同名函数互相覆盖、写死的死代码……
   页面脚本从 index.html / admin.html 里抠出来单独扫 */
const fs = require('fs');
const { ESLint } = require('eslint');
const globals = require('globals');
const { ROOT } = require('../lib/env');
const common = { 'no-undef': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error', 'no-const-assign': 'error',
  'no-redeclare': 'error', 'no-self-assign': 'error', 'no-dupe-else-if': 'error', 'no-duplicate-case': 'error',
  'use-isnan': 'error', 'valid-typeof': 'error', 'no-cond-assign': 'error' };
const config = [
  { files: ['server.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } }, rules: common },
  /* PhotoStack 挂在 window 上（第三方组件），扫描器看不出来 */
  { files: ['index.js', 'admin.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser, PhotoStack: 'readonly' } }, rules: common },
  { files: ['sw.js'], languageOptions: { ecmaVersion: 2024, globals: { ...globals.serviceworker } }, rules: { 'no-undef': 'error' } },
];
(async () => {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config, cwd: ROOT });
  const pageJs = f => [...fs.readFileSync(ROOT + '/' + f, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n;\n');
  const files = [['server.js', fs.readFileSync(ROOT + '/server.js', 'utf8')], ['sw.js', fs.readFileSync(ROOT + '/sw.js', 'utf8')],
                 ['index.js', pageJs('index.html')], ['admin.js', pageJs('admin.html')]];
  for (const [name, code] of files) {
    const [r] = await eslint.lintText(code, { filePath: ROOT + '/' + name });
    const errs = r.messages.filter(m => m.severity === 2);
    console.log((errs.length ? '  XX  ' : '  OK  ') + name + (errs.length ? '：' : ' 没有错'));
    errs.forEach(e => console.log(`        ${e.line}:${e.column}  ${e.message}  (${e.ruleId})`));
  }
})();
