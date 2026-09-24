/* 假的看图模型（他的眼睛，端口 8093）：不管收到什么图，都回 WORK/vdesc.txt 里那句描述。
   默认「她在小红书上看一篇讲露营的笔记」。用来测「把图读成文字」这条路。 */
const { WORK } = require('./env');
const http = require('http'), fs = require('fs');
http.createServer((req, res) => {
  let b = ''; req.setEncoding('utf8'); req.on('data', c => b += c); req.on('end', () => {
    let desc = '她在小红书上看一篇讲露营的笔记';
    try { const t = fs.readFileSync(WORK + '/vdesc.txt', 'utf8').trim(); if (t) desc = t; } catch {}
    let hasImg = false;
    try { const j = JSON.parse(b || '{}'); const m = (j.messages || []).find(x => Array.isArray(x.content)); hasImg = !!(m && m.content.some(c => c.type === 'image_url' || c.type === 'image')); } catch {}
    fs.writeFileSync(WORK + '/vseen.json', JSON.stringify({ at: Date.now(), hasImg }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: hasImg ? desc : '（没收到图）' } }], usage: { prompt_tokens: 500, completion_tokens: 20 } }));
  });
}).listen(8093, () => console.log('假的眼睛就绪'));
