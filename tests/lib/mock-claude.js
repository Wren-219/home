/* 假 Claude（Anthropic 格式）：请求体存进 WORK/areqs.json；学真服务器的脾气，收到 temperature 就 400 */
const { WORK } = require('./env');
const http = require('http'), fs = require('fs');
const LOG = WORK + '/areqs.json', P = WORK + '/plan.json';
http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', async () => {
    let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
    const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
    log.push(body); fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
    if ('temperature' in body || 'top_p' in body || 'top_k' in body) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
        message: 'temperature: Extra inputs are not permitted' } }));
    }
    const plan = fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, 'utf8')) : { steps: ['嗯。'] };
    const step = plan.steps[Math.min(plan.i || 0, plan.steps.length - 1)];
    plan.i = (plan.i || 0) + 1; fs.writeFileSync(P, JSON.stringify(plan));
    const think = (step && step.think) || '', text = typeof step === 'string' ? step : (step.text || '');

    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ content: [{ type: 'text', text }],
        usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 1000 } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const w = (t, o) => res.write('event: ' + t + '\ndata: ' + JSON.stringify({ type: t, ...o }) + '\n\n');
    const nap = ms => new Promise(r => setTimeout(r, ms));
    w('message_start', { message: { usage: { input_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } });
    if (think && body.thinking) {
      w('content_block_start', { index: 0, content_block: { type: 'thinking' } });
      for (const piece of think.match(/.{1,6}/gs) || []) {
        w('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: piece } });
        await nap(60);
      }
      w('content_block_stop', { index: 0 });
    }
    w('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
    for (const piece of text.match(/.{1,5}/gs) || []) {
      w('content_block_delta', { index: 1, delta: { type: 'text_delta', text: piece } });
      await nap(40);
    }
    w('content_block_stop', { index: 1 });
    w('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } });
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n'); res.end();
  });
}).listen(8098, () => console.log('假 Claude 就绪'));
