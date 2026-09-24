/* 用 node -r 预加载：把三家搜索服务和几个假网页拦在本机，别真出网 */
const real = global.fetch;
const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
global.fetch = async (url, opt) => {
  const u = String(url && url.url ? url.url : url);
  const auth = ((opt && opt.headers) || {});
  if (u.includes('api.tavily.com')) {
    if (auth.Authorization !== 'Bearer tv-good') return R({ detail: 'bad key' }, 401);
    return R({ answer: '今天是星期三。', results: [
      { title: '新闻一', url: 'https://a.example/1', content: '正文摘要\n  带换行和   多空格' },
      { title: '新闻二', url: 'https://a.example/2', content: 'x'.repeat(500) },
    ] });
  }
  if (u.includes('api.search.brave.com')) {
    if (auth['X-Subscription-Token'] !== 'br-good') return R({}, 422);
    return R({ web: { results: [{ title: 'Brave 一', url: 'https://b.example/1', description: 'brave 摘要' }] } });
  }
  if (u.includes('api.bochaai.com')) {
    if (auth.Authorization !== 'Bearer bo-good') return R({}, 403);
    return R({ data: { webPages: { value: [{ name: '博查一', url: 'https://c.example/1', snippet: '短的', summary: '长一点的总结' }] } } });
  }
  if (u.includes('page.example')) {
    return new Response('<html><head><title>  一篇文章  </title></head><body><script>var x=1;alert("别把我读进去")</script><style>p{color:red}</style><h1>标题在这儿</h1><p>第一段&nbsp;正文&amp;符号</p><p>第二段</p></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (u.includes('pdf.example')) return new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (u.includes('gone.example')) return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
  return real(url, opt);
};

/* ---- 假 ElevenLabs：说（TTS）回一小段真能放的 WAV，听（STT）回 WORK/stt.txt 里那句话。
       每次请求都记进 WORK/eleven.json，测试拿来看发过去的是什么 ---- */
{
  const fs = require('fs');
  const { WORK } = require('./env');
  const LOG = WORK + '/eleven.json';
  const wav = secs => {   /* 一段 440Hz 的小声，采样率 8k，够放、够短 */
    const sr = 8000, n = Math.round(sr * secs), b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / sr * 2 * Math.PI * 440) * 3000), 44 + i * 2);
    return b;
  };
  const prev = global.fetch;
  global.fetch = async (url, opt) => {
    const u = String(url && url.url ? url.url : url);
    if (!u.includes('api.elevenlabs.io')) return prev(url, opt);
    const h = (opt && opt.headers) || {};
    const log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
    const R = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json' } });
    if (h['xi-api-key'] !== 'el-good') { log.push({ path: new URL(u).pathname, bad: true }); fs.writeFileSync(LOG, JSON.stringify(log)); return R({ detail: 'invalid api key' }, 401); }
    if (u.includes('/v1/text-to-speech/')) {
      const body = JSON.parse(opt.body);
      const q = new URL(u);
      log.push({ path: q.pathname, format: q.searchParams.get('output_format'), text: body.text, model: body.model_id,
        settings: body.voice_settings || null, prev: body.previous_text || '', next: body.next_text || '' });
      fs.writeFileSync(LOG, JSON.stringify(log));
      return new Response(wav(Math.min(1.2, 0.2 + body.text.length * 0.03)), { status: 200, headers: { 'content-type': 'audio/wav' } });
    }
    if (u.includes('/v1/speech-to-text')) {
      const fd = opt.body, file = fd.get('file');
      log.push({ path: '/v1/speech-to-text', model: fd.get('model_id'), size: file ? file.size : 0, type: file ? file.type : '' });
      fs.writeFileSync(LOG, JSON.stringify(log));
      const text = fs.existsSync(WORK + '/stt.txt') ? fs.readFileSync(WORK + '/stt.txt', 'utf8') : '我今天有点累';
      return R({ text, language_code: 'zho' });
    }
    return R({ detail: 'not found' }, 404);
  };
}

/* 邮件：连 smtp.fake 的一律转到本机 8094 那个假邮件服务器（lib/fake-smtp.js），明文就行 */
const tls = require('tls'), net = require('net');
const realTls = tls.connect;
tls.connect = function (opts, cb) {
  if (opts && opts.host === 'smtp.fake') return net.connect(8094, '127.0.0.1', cb);
  return realTls.apply(this, arguments);
};
