/* 生成一段「假人声」当麦克风：静 1 秒 → 说 1.6 秒 → 静 2.4 秒（Chromium 会循环放）。
   纯正弦波会被降噪当成噪音滤掉，所以做成音高在变、有泛音、有音节起伏的样子 */
const fs = require('fs');
module.exports = function fakeMic(file) {
  const sr = 16000, secs = 5, n = sr * secs, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = (Math.random() - 0.5) * 0.004;                       // 一点底噪
    if (t >= 1 && t < 2.6) {
      const f0 = 200 + 40 * Math.sin(2 * Math.PI * 1.3 * t);     // 音高在变
      ph += 2 * Math.PI * f0 / sr;
      const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);   // 一秒四个音节
      v += env * 0.45 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) / 1.75;
    }
    b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(file, b);
  return file;
};
