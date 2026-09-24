/* 会思考的假模型（OpenAI 格式）：先慢慢吐一段 reasoning_content，再吐正文 */
const { WORK } = require('./env');
const http = require('http'), fs = require('fs');
const P = WORK + '/plan.json';
http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', async () => {
    let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
    const plan = fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, 'utf8')) : { steps: ['嗯。'] };
    const step = plan.steps[Math.min(plan.i || 0, plan.steps.length - 1)];
    plan.i = (plan.i || 0) + 1; fs.writeFileSync(P, JSON.stringify(plan));
    const usage = { prompt_tokens: 1200, completion_tokens: 30, prompt_cache_hit_tokens: 1000 };
    const think = (step && step.think) || '';
    const text = typeof step === 'string' ? step : (step.text || '');

    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const w = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const nap = ms => new Promise(r => setTimeout(r, ms));
    for (const piece of think.match(/.{1,6}/gs) || []) {
      w({ choices: [{ delta: { reasoning_content: piece } }] });
      await nap(60);
    }
    for (const piece of text.match(/.{1,5}/gs) || []) {
      w({ choices: [{ delta: { content: piece } }] });
      await nap(40);
    }
    w({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    w({ usage });
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(8099, () => console.log('会思考的假模型就绪'));
