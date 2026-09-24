/* 会思考的假模型（OpenAI 格式，学 DeepSeek 的思考模式）：先吐 reasoning_content，再吐正文或工具调用。
   学真服务器的脾气：请求里调过工具的那条 assistant，如果没把 reasoning_content 带回来 → 400。
   请求体存进 WORK/treqs.json。plan.json 的一步可以是：字符串 / { think, text } / { think, tool, args } */
const { WORK } = require('./env');
const http = require('http'), fs = require('fs');
const P = WORK + '/plan.json', LOG = WORK + '/treqs.json';
http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', async () => {
    let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
    const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
    log.push(body); fs.writeFileSync(LOG, JSON.stringify(log));
    for (const m of body.messages || []) {
      if (m.role === 'assistant' && m.tool_calls && !m.reasoning_content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'The `reasoning_content` in the thinking mode must be passed back to the API.', type: 'invalid_request_error' } }));
      }
    }
    const plan = fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, 'utf8')) : { steps: ['嗯。'] };
    const step = plan.steps[Math.min(plan.i || 0, plan.steps.length - 1)];
    plan.i = (plan.i || 0) + 1; fs.writeFileSync(P, JSON.stringify(plan));
    const usage = { prompt_tokens: 1200, completion_tokens: 30, prompt_cache_hit_tokens: 1000 };
    const think = (step && step.think) || '';
    const text = typeof step === 'string' ? step : (step.text || '');
    const tool = step && step.tool ? { id: 'call_' + Date.now().toString(36), name: step.tool, args: JSON.stringify(step.args || {}) } : null;

    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const message = { content: text, reasoning_content: think };
      if (tool) message.tool_calls = [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args } }];
      return res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const w = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const nap = ms => new Promise(r => setTimeout(r, ms));
    for (const piece of think.match(/.{1,6}/gs) || []) { w({ choices: [{ delta: { reasoning_content: piece } }] }); await nap(60); }
    for (const piece of text.match(/.{1,5}/gs) || []) { w({ choices: [{ delta: { content: piece } }] }); await nap(40); }
    if (tool) {
      w({ choices: [{ delta: { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } }] } }] });
      w({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: tool.args } }] } }] });
    }
    w({ choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] });
    w({ usage });
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(8099, () => console.log('会思考的假模型就绪'));
