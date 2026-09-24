/* 假推送服务：检查 VAPID 头，按 endpoint 路径回 201 / 404 / 410 / 500 */
require('http').createServer((req, res) => {
  let n = 0; req.on('data', c => n += c.length);
  req.on('end', () => {
    const p = req.url;
    const auth = req.headers.authorization || '';
    /* 顺带验一下每条请求的头对不对 */
    const bad = !/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{80,}$/.test(auth)
      ? 'Authorization 不对：' + auth.slice(0, 40)
      : req.headers['content-encoding'] !== 'aes128gcm' ? 'Content-Encoding 不对'
      : !req.headers.ttl ? '没带 TTL' : null;
    if (bad) { res.writeHead(400); return res.end(bad); }
    if (p.includes('/gone')) { res.writeHead(410); return res.end('gone'); }
    if (p.includes('/missing')) { res.writeHead(404); return res.end('not found'); }
    if (p.includes('/boom')) { res.writeHead(500); return res.end('oops'); }
    res.writeHead(201); res.end('');
  });
}).listen(8096, () => console.log('假推送服务就绪'));
