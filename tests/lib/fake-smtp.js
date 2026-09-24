/* 假邮件服务器（明文，端口 8094）：照 SMTP 的规矩一问一答，收到的每封信原样存成 WORK/smtp/<n>.eml。
   授权码不是 good-pass 就在第 5 步拒掉，像真的一样 */
const { WORK } = require('./env');
const net = require('net'), fs = require('fs'), path = require('path');
const DIR = path.join(WORK, 'smtp');
fs.mkdirSync(DIR, { recursive: true });
for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f));
let n = 0;
net.createServer(sock => {
  let buf = '', inData = false, data = '', step = 0;
  const say = t => sock.write(t + '\r\n');
  say('220 fake.smtp ready');
  sock.on('data', chunk => {
    buf += chunk.toString('utf8');
    while (true) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) { data += buf; buf = ''; return; }
        data += buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
        fs.writeFileSync(path.join(DIR, (++n) + '.eml'), data.replace(/\r\n\.\./g, '\r\n.'));
        data = ''; say('250 queued'); continue;
      }
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2); step++;
      if (/^EHLO/i.test(line)) say('250-fake.smtp\r\n250 AUTH LOGIN');
      else if (/^AUTH LOGIN/i.test(line)) say('334 VXNlcm5hbWU6');
      else if (step === 3) say('334 UGFzc3dvcmQ6');
      else if (step === 4) say(Buffer.from(line, 'base64').toString() === 'good-pass' ? '235 ok' : '535 auth failed');
      else if (/^MAIL FROM/i.test(line) || /^RCPT TO/i.test(line)) say('250 ok');
      else if (/^DATA/i.test(line)) { inData = true; say('354 go ahead'); }
      else if (/^QUIT/i.test(line)) { say('221 bye'); sock.end(); }
      else say('250 ok');
    }
  });
  sock.on('error', () => {});
}).listen(8094, () => console.log('假邮件服务器就绪'));
