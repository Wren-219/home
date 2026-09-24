/* 会缓存的假模型（OpenAI 格式，学 DeepSeek 的前缀缓存）：
   记着以前每一次请求，这次跟它们「从头开始逐字相同」的最长那段算命中。
   用字数当 token 数 —— 只看比例，不求精确。
   plan.json 的一步可以是：字符串 / { text, flush: true }（flush = 假装服务商那边缓存被清了） */
const { WORK } = require('./env');
const http = require('http'), fs = require('fs');
const P = WORK + '/plan.json';
let seen = [];
const lcp = (a, b) => { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; };
http.createServer((req, res) => {
  let b = ''; req.setEncoding('utf8'); req.on('data', c => b += c); req.on('end', () => {
    let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
    const plan = fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, 'utf8')) : { steps: ['嗯。'] };
    const step = plan.steps[Math.min(plan.i || 0, plan.steps.length - 1)];
    plan.i = (plan.i || 0) + 1; fs.writeFileSync(P, JSON.stringify(plan));
    if (step && step.flush) seen = [];
    /* 服务商比的是它收到的字节：工具在前，然后是一条条消息 */
    const flat = JSON.stringify(body.tools || []) + (body.messages || []).map(m => JSON.stringify(m)).join('');
    const hit = seen.reduce((best, s) => Math.max(best, lcp(s, flat)), 0);
    seen.push(flat); if (seen.length > 50) seen.shift();
    const usage = { prompt_tokens: flat.length, completion_tokens: 20, prompt_cache_hit_tokens: hit };
    const text = typeof step === 'string' ? step : (step.text || '嗯。');
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ usage }) + '\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(8099, () => console.log('会缓存的假模型就绪'));
