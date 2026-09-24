/* 假模型（OpenAI 格式）：把每次收到的完整请求体按顺序存进 WORK/reqs.json，用来比对缓存前缀 */
const { WORK } = require('./env');
const http = require('http'), fs = require('fs');
const P = WORK + '/plan.json', LOG = WORK + '/reqs.json';
http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
    const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
    log.push(body); fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
    const plan = fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, 'utf8')) : { steps: ['{"say":false}'] };
    const step = plan.steps[Math.min(plan.i || 0, plan.steps.length - 1)];
    plan.i = (plan.i || 0) + 1; fs.writeFileSync(P, JSON.stringify(plan));
    const usage = { prompt_tokens: 1200, completion_tokens: 30, prompt_cache_hit_tokens: 1000 };

    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (step && step.tool) {
        return res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [
          { id: 'c1', type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] } }], usage }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { content: typeof step === 'string' ? step : JSON.stringify(step) } }], usage }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const w = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    w({ choices: [{ delta: { content: typeof step === 'string' ? step : JSON.stringify(step) } }] });
    w({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    w({ usage });
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(8099, () => console.log('假模型就绪'));
