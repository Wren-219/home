/* 假模型（OpenAI 格式）：流式、能发起工具调用。WORK/plan.json 决定每次回什么，收到的请求存到 WORK/last.json */
const { WORK } = require('./env');
const http = require('http'), fs = require('fs');
const P = WORK + '/plan.json';
http.createServer((req, res) => {
  let b = ''; req.setEncoding('utf8'); req.on('data', c => b += c); req.on('end', () => {
    let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
    fs.writeFileSync(WORK + '/last.json', JSON.stringify(body, null, 2));
    const plan = fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, 'utf8')) : { steps: ['{"say":false}'] };
    const step = plan.steps[Math.min(plan.i || 0, plan.steps.length - 1)];
    plan.i = (plan.i || 0) + 1; fs.writeFileSync(P, JSON.stringify(plan));

    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const usage = { prompt_tokens: 1200, completion_tokens: 30, prompt_cache_hit_tokens: 1000 };
      if (typeof step === 'object' && step.tool) {
        return res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }] }, finish_reason: 'tool_calls' }], usage }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { content: String(step) } }], usage }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const w = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (typeof step === 'object' && step.tool) {
      w({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: step.tool, arguments: '' } } ] } }] });
      w({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] } }] });
      w({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      w({ choices: [{ delta: { content: String(step) } }] });
      w({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    w({ usage: { prompt_tokens: 1200, completion_tokens: 30 } });
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(8099, () => console.log('mock 就绪'));
