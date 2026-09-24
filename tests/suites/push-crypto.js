const { ROOT, chromiumPath } = require('../lib/env');
/* 加密对不对，自己说了不算 —— 让浏览器那套完全独立的 WebCrypto 去解。
   两边都是按 RFC 8291 各写各的，解得开才说明没写错。 */
const { chromium } = require('playwright-core'); const fs = require('fs'), crypto = require('crypto');
const src = fs.readFileSync(ROOT + '/server.js', 'utf8');

/* 把 push 那几个函数从 server.js 里抠出来单独跑，不启动整个服务器 */
const pick = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const mod = pick('function b64u(buf)', 'async function pushOne(');
const ctx = { crypto, Buffer, URL, console, readJson: () => ({}), writeJson: () => {}, mailConf: () => ({ user: 'a@b.c' }) };
const fn = new Function(...Object.keys(ctx), mod + '; return { pushEncrypt, b64u, unb64u, rawToKey, vapidAuth };');
const P = fn(...Object.values(ctx));

(async () => {
  /* WebCrypto 要 secure context，localhost 算。起个一行的空页面服务 */
  const srv = require('http').createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end('<html><body>ok'); }).listen(8097);
  const b = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
  const page = await (await b.newContext()).newPage();
  await page.goto('http://localhost:8097/', { waitUntil: 'domcontentloaded' });
  const ok = (c, m) => console.log((c ? '  OK  ' : '  XX  ') + m);

  /* 浏览器里生成一对密钥，扮演她的手机 */
  const ua = await page.evaluate(async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const b64 = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    window.__priv = priv;
    return { pub: b64(pub), auth: b64(auth) };
  });
  ok(P.unb64u(ua.pub).length === 65, '她那边的公钥是 65 字节');

  const MSG = JSON.stringify({ title: '晤', body: '睡了吗？都一点了。', url: '/' });
  const enc = P.pushEncrypt(MSG, P.unb64u(ua.pub), P.unb64u(ua.auth));
  console.log('      加出来 ' + enc.length + ' 字节');
  ok(enc.length > 86, '长度合理（头 86 字节 + 密文 + 16 字节校验）');
  ok(enc.readUInt32BE(16) === 4096, 'rs 字段是 4096');
  ok(enc[20] === 65, 'keyid 长度字段是 65');
  ok(enc[21] === 4, '带的是未压缩点（0x04 开头）');

  /* 浏览器独立按 RFC 8291 解一遍 */
  const back = await page.evaluate(async ({ encB64, uaPub, uaAuth }) => {
    const un = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const cat = (...a) => { const t = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { t.set(x, o); o += x.length; } return t; };
    const body = un(encB64);
    const salt = body.slice(0, 16);
    const idlen = body[20];
    const asPub = body.slice(21, 21 + idlen);
    const ct = body.slice(21 + idlen);

    const priv = await crypto.subtle.importKey('jwk', window.__priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, priv, 256));

    const hkdf = async (ikm, slt, info, len) => {
      const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
      return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: slt, info }, k, len * 8));
    };
    const enc8 = s => new TextEncoder().encode(s);
    const keyInfo = cat(enc8('WebPush: info\0'), un(uaPub), asPub);
    const ikm = await hkdf(shared, un(uaAuth), keyInfo, 32);
    const cek = await hkdf(ikm, salt, enc8('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(ikm, salt, enc8('Content-Encoding: nonce\0'), 12);

    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ct));
    return { text: new TextDecoder().decode(pt.slice(0, -1)), pad: pt[pt.length - 1] };
  }, { encB64: enc.toString('base64url'), uaPub: ua.pub, uaAuth: ua.auth });

  ok(back.text === MSG, '浏览器独立解出来了，跟原文一个字不差');
  console.log('      解出来：' + back.text);
  ok(back.pad === 2, '结束符是 0x02（单条记录）');

  /* 换一把钥匙就该解不开 —— 证明不是巧合 */
  const wrong = P.pushEncrypt(MSG, P.unb64u(ua.pub), crypto.randomBytes(16));
  const failed = await page.evaluate(async ({ encB64, uaPub, uaAuth }) => {
    try {
      const un = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const cat = (...a) => { const t = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { t.set(x, o); o += x.length; } return t; };
      const body = un(encB64), salt = body.slice(0, 16), idlen = body[20];
      const asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
      const priv = await crypto.subtle.importKey('jwk', window.__priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, priv, 256));
      const hkdf = async (ikm, slt, info, len) => {
        const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
        return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: slt, info }, k, len * 8));
      };
      const e8 = s => new TextEncoder().encode(s);
      const ikm = await hkdf(shared, un(uaAuth), cat(e8('WebPush: info\0'), un(uaPub), asPub), 32);
      const cek = await hkdf(ikm, salt, e8('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(ikm, salt, e8('Content-Encoding: nonce\0'), 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ct);
      return false;
    } catch { return true; }
  }, { encB64: wrong.toString('base64url'), uaPub: ua.pub, uaAuth: ua.auth });
  ok(failed, 'auth secret 不对就解不开（说明不是瞎蒙对的）');

  /* VAPID 的 JWT：浏览器验签 */
  const v = P.vapidAuth('https://web.push.apple.com/abc');
  const [h, pl, sg] = v.jwt.split('.');
  const claims = JSON.parse(Buffer.from(pl, 'base64url'));
  ok(JSON.parse(Buffer.from(h, 'base64url')).alg === 'ES256', 'JWT 头是 ES256');
  ok(claims.aud === 'https://web.push.apple.com', 'aud 是推送服务的 origin：' + claims.aud);
  ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600, 'exp 在 24 小时内');
  ok(Buffer.from(sg, 'base64url').length === 64, '签名是 64 字节的裸 r||s（不是 DER）');
  const sigOk = await page.evaluate(async ({ pub, signed, sig }) => {
    const un = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const k = await crypto.subtle.importKey('raw', un(pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, un(sig), new TextEncoder().encode(signed));
  }, { pub: v.pub, signed: h + '.' + pl, sig: sg });
  ok(sigOk, '浏览器用那把公钥验签通过 —— 推送服务也是这么验的');

  await b.close(); srv.close();
})();
