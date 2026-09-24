/* 假 Claude（Anthropic 格式）：请求体存进 WORK/areqs.json。学真服务器的脾气：
   · 收到 temperature / top_p / top_k 就 400（Opus 4.7 起都被移除了）
   · 跟 claude-opus-5 一样默认就会想：每次回复都先有一个带签名的思考块
     （没开 display: summarized 时思考内容是空的，跟真的一样）
   · 请求里调过工具的那条 assistant，如果没把思考块原样带回来 → 400
   plan.json 的一步可以是：字符串 / { text, think } / { tool, args, think } */
const { WORK } = require('./env');
const http = require('http'), fs = require('fs');
const LOG = WORK + '/areqs.json', P = WORK + '/plan.json';
const SIG = 'sig-ok';
const bad = (res, message) => { res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } })); };
http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', async () => {
    let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
    const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
    log.push(body); fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
    if ('temperature' in body || 'top_p' in body || 'top_k' in body) return bad(res, 'temperature: Extra inputs are not permitted');
    /* 调过工具却没带回思考块 */
    for (const [i, m] of (body.messages || []).entries()) {
      if (m.role !== 'assistant' || !Array.isArray(m.content) || !m.content.some(x => x.type === 'tool_use')) continue;
      const first = m.content[0];
      if (!first || (first.type !== 'thinking' && first.type !== 'redacted_thinking'))
        return bad(res, `messages.${i}.content.0.type: Expected \`thinking\` or \`redacted_thinking\`, but found \`${first && first.type}\`. When \`thinking\` is enabled, a final \`assistant\` message must start with a thinking block.`);
      if (first.type === 'thinking' && first.signature !== SIG) return bad(res, `messages.${i}.content.0: Invalid \`signature\` in \`thinking\` block`);
    }
    const plan = fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, 'utf8')) : { steps: ['嗯。'] };
    const step = plan.steps[Math.min(plan.i || 0, plan.steps.length - 1)];
    plan.i = (plan.i || 0) + 1; fs.writeFileSync(P, JSON.stringify(plan));
    const shown = !!(body.thinking && body.thinking.display === 'summarized');
    const think = shown ? ((step && step.think) || '') : '';
    const text = typeof step === 'string' ? step : (step.text || '');
    const tool = step && step.tool ? { id: 'toolu_' + Date.now().toString(36), name: step.tool, input: step.args || {} } : null;
    const usage = { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 1000 };

    if (!body.stream) {
      const content = [{ type: 'thinking', thinking: think, signature: SIG }];
      if (text) content.push({ type: 'text', text });
      if (tool) content.push({ type: 'tool_use', ...tool });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ content, stop_reason: tool ? 'tool_use' : 'end_turn', usage }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const w = (t, o) => res.write('event: ' + t + '\ndata: ' + JSON.stringify({ type: t, ...o }) + '\n\n');
    const nap = ms => new Promise(r => setTimeout(r, ms));
    w('message_start', { message: { usage: { input_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } });
    let idx = 0;
    w('content_block_start', { index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } });
    for (const piece of think.match(/.{1,6}/gs) || []) { w('content_block_delta', { index: idx, delta: { type: 'thinking_delta', thinking: piece } }); await nap(60); }
    w('content_block_delta', { index: idx, delta: { type: 'signature_delta', signature: SIG } });
    w('content_block_stop', { index: idx });
    if (text) {
      idx++;
      w('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
      for (const piece of text.match(/.{1,5}/gs) || []) { w('content_block_delta', { index: idx, delta: { type: 'text_delta', text: piece } }); await nap(40); }
      w('content_block_stop', { index: idx });
    }
    if (tool) {
      idx++;
      w('content_block_start', { index: idx, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
      const js = JSON.stringify(tool.input);
      w('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: js.slice(0, 5) } });
      w('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: js.slice(5) } });
      w('content_block_stop', { index: idx });
    }
    w('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 40 } });
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n'); res.end();
  });
}).listen(8098, () => console.log('假 Claude 就绪'));
