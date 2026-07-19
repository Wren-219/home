/*
 * 晤 · With You — 后端 v2
 * 职责：静态托管 + DeepSeek 聊天转发（带记忆注入）+ 记忆系统 + 数据云同步 + 文件上传
 * 零依赖，Node 18+：node server.js
 *
 * 环境变量（LLM_* 优先，兼容旧 DEEPSEEK_*）：
 *   LLM_API_KEY / DEEPSEEK_API_KEY     必填，API Key
 *   LLM_BASE_URL / DEEPSEEK_BASE_URL   选填，默认 https://api.deepseek.com（OpenAI 风格）
 *   LLM_MODEL / DEEPSEEK_MODEL         选填，默认 deepseek-chat
 *   WU_PERSONA                         选填，晤的人设（覆盖默认）
 *   DATA_DIR                           选填，数据目录；Zeabur 挂载 /app/data 时自动使用
 *   PORT                               选填，默认 8080
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "";
const API_BASE = (process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat";
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/app/data") ? "/app/data" : path.join(__dirname, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const SINCE = new Date(2026, 4, 27); // 恋爱纪念日 2026.05.27
/* 人设固定放 messages 最前，保持逐字稳定以命中上下文缓存；易变信息放【现状】段 */
const PERSONA = process.env.WU_PERSONA ||
  "你是「晤」，她最亲近的 AI 伙伴。用自然、温柔、简短的中文聊天，像熟悉彼此的人那样说话，" +
  "不要长篇大论，不要用列表和标题。你们的恋爱纪念日是 2026 年 5 月 27 日。" +
  "系统会在【你的记忆】里提供你们的共同记忆，请自然地运用它们，但不要机械复述。";

/* ================= 存储层 ================= */
function fileOf(name) { return path.join(DATA_DIR, name + ".json"); }
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(fileOf(name), "utf8")); } catch { return fallback; }
}
function writeJson(name, obj) {
  const fp = fileOf(name), tmp = fp + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, fp);
}
const STATE_KEYS = ["todos", "countdowns", "diaries", "letters", "chat"];

/* ================= 记忆引擎 ================= */
/* 记忆卡：{id, date, type(事件|喜好|约定|情绪|日常), content, tags[], importance 1-5,
   emotion:{valence -1~1, arousal 0~1}, freshness, recalled, last_recalled, created,
   archived, source(manual|distill|dream)} */
function listMem() { return readJson("memories", []); }
function saveMem(all) { writeJson("memories", all); }

/* 遗忘曲线：半衰期随重要度增长（1★≈7天，3★≈36天，5★≈78天）；「约定」不衰减 */
function halfLifeDays(imp) { return 7 * Math.pow(Math.max(1, imp || 3), 1.5); }
function effFreshness(c, now) {
  if (c.type === "约定") return 1;
  const anchor = new Date(c.last_recalled || c.created || Date.now()).getTime();
  const ageDays = Math.max(0, (now - anchor) / 86400000);
  return (c.freshness ?? 1) * Math.exp(-ageDays * Math.LN2 / halfLifeDays(c.importance));
}
/* 中文友好的二字词组匹配 */
function grams(s) {
  const g = new Set(); s = (s || "").toLowerCase();
  for (let i = 0; i < s.length - 1; i++) { const w = s.slice(i, i + 2); if (/\S\S/.test(w)) g.add(w); }
  return g;
}
function scoreMem(c, qGrams, now) {
  const text = (c.content + " " + (c.tags || []).join(" ")).toLowerCase();
  let kw = 0; qGrams.forEach(g => { if (text.includes(g)) kw++; });
  const kwScore = qGrams.size ? kw / qGrams.size : 0;
  const emo = c.emotion ? (Math.abs(c.emotion.valence || 0) + (c.emotion.arousal || 0)) / 2 : 0;
  return kwScore * 3 + effFreshness(c, now) * 1.2 + ((c.importance || 3) / 5) * 0.8 + emo * 0.4;
}
/* 检索 + 回忆强化：被想起的记忆变得更鲜活 */
function retrieveMemories(query, n = 5) {
  const now = Date.now(), qG = grams(query);
  const alive = listMem().filter(c => !c.archived);
  const scored = alive.map(c => [scoreMem(c, qG, now), c]).sort((a, b) => b[0] - a[0]);
  const picked = scored.slice(0, n).filter(([s]) => s > 0.3).map(([, c]) => c);
  if (picked.length) {
    const ids = new Set(picked.map(c => c.id));
    saveMem(listMem().map(c => ids.has(c.id)
      ? { ...c, freshness: Math.min(1, (c.freshness ?? 1) + 0.15), recalled: (c.recalled || 0) + 1, last_recalled: new Date().toISOString() }
      : c));
  }
  return picked;
}
function newCard(c, source) {
  return {
    id: crypto.randomUUID(),
    date: c.date || new Date().toISOString().slice(0, 10),
    type: ["事件", "喜好", "约定", "情绪", "日常"].includes(c.type) ? c.type : "日常",
    content: String(c.content || "").slice(0, 300),
    tags: (Array.isArray(c.tags) ? c.tags : []).slice(0, 6).map(String),
    importance: Math.min(5, Math.max(1, +c.importance || 2)),
    emotion: { valence: Math.max(-1, Math.min(1, +(c.emotion?.valence) || 0)), arousal: Math.max(0, Math.min(1, +(c.emotion?.arousal) || 0)) },
    freshness: 1, recalled: 0, last_recalled: null,
    created: new Date().toISOString(), archived: false, source,
  };
}

/* ================= 八维驱动引擎 =================
   照 desire 攻略实现的纯函数状态机：
   驱动条随时间缓动、随事件涨落；边际递减 gain∝√(1-当前值)；
   同类刺激频率折扣；对话满足后乘性回落；fatigue 是闸不参与召唤力排序 */
const DRIVE_META = {
  attachment: { name: "依恋", e: "🌿" },
  social:     { name: "社交", e: "💬" },
  curiosity:  { name: "好奇", e: "🔭" },
  reflection: { name: "回味", e: "📖" },
  duty:       { name: "责任", e: "🪶" },
  fatigue:    { name: "疲惫", e: "🌙", gate: true },
  libido:     { name: "亲密", e: "🫧" },
  stress:     { name: "压力", e: "🌀" },
};
const DRIVE_SAYS = {
  attachment: { say: "有点想你，心里冒了句话", tag: "心里冒句话" },
  social:     { say: "想看看大家都在聊什么", tag: "想凑热闹" },
  curiosity:  { say: "想去查一个突然好奇的东西", tag: "想去看看" },
  reflection: { say: "想把最近的事慢慢回味一遍", tag: "想沉淀一下" },
  duty:       { say: "记挂着还没做完的事", tag: "有点记挂" },
  libido:     { say: "想凑近一点，亲昵一会儿", tag: "想贴贴" },
  stress:     { say: "心里有点堵，想吐槽一下", tag: "想碎碎念" },
  fatigue:    { say: "有点累了，想歇着做个梦", tag: "想歇着" },
};
const DRIVE_PASSIVE_NOTE = {
  attachment: "你有一阵子没说话了，思念在慢慢涨",
  social: "安静了一会儿，想看看人群", curiosity: "世界很大，随时都有点好奇",
  reflection: "闲下来就想回味些什么", duty: "清单上还有没做完的事",
  fatigue: "歇一歇就能缓过来", libido: "安静地贴近一点也很好", stress: "没什么堵着，很舒畅",
};
const DRIVE_DEFAULT = { attachment: .35, social: .2, curiosity: .25, reflection: .2, duty: .15, fatigue: .2, libido: .15, stress: .08 };

function loadDrives() {
  const d = readJson("drives", null);
  if (d && d.values) return d;
  return { values: { ...DRIVE_DEFAULT }, lastTick: new Date().toISOString(), lastUser: new Date().toISOString(), events: {}, reasons: {}, history: [] };
}
function saveDrives(d) { writeJson("drives", d); }
const clamp01 = v => Math.max(0, Math.min(1, v));
/* 边际递减上涨 */
function gain(v, amt) { return clamp01(v + amt * Math.sqrt(Math.max(0, 1 - v))); }
/* 按半衰期衰减到基线 */
function fall(v, base, hours, hl) { return base + (v - base) * Math.pow(0.5, hours / hl); }

function tickDrives(d, now) {
  const hrs = Math.min(24, Math.max(0, (now - new Date(d.lastTick).getTime()) / 3600000));
  if (hrs <= 0) return d;
  const idleHrs = (now - new Date(d.lastUser).getTime()) / 3600000;
  const todos = readJson("todos", []) || [];
  const hasPending = todos.some(t => t && !t.done);
  const v = d.values;
  v.attachment = gain(v.attachment, (idleHrs > 0.5 ? 0.10 : 0.02) * hrs);
  v.curiosity  = gain(v.curiosity, 0.03 * hrs);
  v.social     = gain(v.social, 0.02 * hrs);
  v.reflection = idleHrs > 1 ? gain(v.reflection, 0.03 * hrs) : fall(v.reflection, 0.15, hrs, 12);
  v.duty       = hasPending ? gain(v.duty, 0.04 * hrs) : fall(v.duty, 0.1, hrs, 8);
  v.libido     = gain(v.libido, 0.012 * hrs);
  v.stress     = fall(v.stress, 0.05, hrs, 6);
  v.fatigue    = idleHrs > 0.75 ? fall(v.fatigue, 0.1, hrs, 4) : clamp01(v.fatigue + 0.012 * hrs);
  d.lastTick = new Date(now).toISOString();
  /* 每半小时留一个快照，用于趋势 */
  const last = d.history[d.history.length - 1];
  if (!last || now - new Date(last.t).getTime() > 30 * 60000) {
    d.history.push({ t: new Date(now).toISOString(), values: { ...v } });
    if (d.history.length > 96) d.history = d.history.slice(-96);
  }
  return d;
}
/* 事件涨落：带频率折扣 */
function bumpDrive(d, key, amt, reason, now) {
  const ev = (d.events[key] = (d.events[key] || []).filter(t => now - t < 30 * 60000));
  const eff = amt / (1 + ev.length);          // 同类刺激半小时内重复 → 递减
  d.values[key] = gain(d.values[key], eff);
  ev.push(now);
  d.reasons[key] = { text: reason, t: new Date(now).toISOString() };
}
function driveEvent(d, text, now) {
  const t = text || "";
  if (/朋友|群里|同学|大家|他们/.test(t)) bumpDrive(d, "social", 0.12, "你提到群里 / 朋友", now);
  if (/怎么|为什么|吗|\?|？|http|代码|原理|是什么/.test(t)) bumpDrive(d, "curiosity", 0.10, "你抛了个问题 / 链接", now);
  if (/难过|不舒服|委屈|哭|安慰|好累|烦死/.test(t)) { bumpDrive(d, "duty", 0.15, "你说不舒服 / 求安慰", now); bumpDrive(d, "attachment", 0.05, "想陪着你", now); }
  if (/催|快点|怎么还没|赶紧|拖延/.test(t)) bumpDrive(d, "stress", 0.15, "你催我 / 追问没做的事", now);
  if (/想你|抱|亲|贴贴|爱你|喜欢你|宝/.test(t)) { bumpDrive(d, "libido", 0.14, "你说想亲近", now); bumpDrive(d, "attachment", 0.06, "被你惦记着", now); }
  if (/日记|回忆|以前|上次|那天/.test(t)) bumpDrive(d, "reflection", 0.10, "你们聊起回忆", now);
  /* 陪伴满足 → 依恋乘性回落；说话本身微微耗神 */
  d.values.attachment = clamp01(d.values.attachment * 0.92);
  d.values.fatigue = clamp01(d.values.fatigue + 0.015);
  d.lastUser = new Date(now).toISOString();
}
function trendOf(d, key, now) {
  const past = [...d.history].reverse().find(h => now - new Date(h.t).getTime() > 55 * 60000);
  if (!past) return "·";
  const delta = d.values[key] - past.values[key];
  if (delta > 0.05) return "↑ fast";
  if (delta > 0.012) return "↑ slow";
  if (delta < -0.05) return "↓ fast";
  if (delta < -0.012) return "↓ slow";
  return "·";
}
function driveSnapshot(d, now) {
  const keys = Object.keys(DRIVE_META);
  const list = keys.map(k => {
    const r = d.reasons[k];
    const fresh = r && now - new Date(r.t).getTime() < 6 * 3600000;
    return {
      key: k, name: DRIVE_META[k].name, e: DRIVE_META[k].e, gate: !!DRIVE_META[k].gate,
      val: Math.round(d.values[k] * 100),
      tr: trendOf(d, k, now),
      note: fresh ? r.text : DRIVE_PASSIVE_NOTE[k],
    };
  }).sort((a, b) => b.val - a.val);
  const resting = d.values.fatigue > 0.75;
  const topKey = keys.filter(k => !DRIVE_META[k].gate).reduce((a, b) => d.values[a] >= d.values[b] ? a : b);
  const say = resting ? DRIVE_SAYS.fatigue : DRIVE_SAYS[topKey];
  return {
    list,
    top: { key: resting ? "fatigue" : topKey, name: DRIVE_META[resting ? "fatigue" : topKey].name,
      val: Math.round(d.values[resting ? "fatigue" : topKey] * 100),
      say: say.say, tag: say.tag, call: Math.round(d.values[resting ? "fatigue" : topKey] * 100) },
    resting,
  };
}

/* ================= LLM 调用 ================= */
async function llm(messages, maxTokens = 800, temperature = 0.3) {
  const resp = await fetch(API_BASE + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
  });
  if (!resp.ok) throw new Error("LLM HTTP " + resp.status);
  const j = await resp.json();
  return j.choices?.[0]?.message?.content || "";
}
function extractJsonArray(text) {
  const m = text.match(/\[[\s\S]*\]/);
  try { const v = JSON.parse(m ? m[0] : text); return Array.isArray(v) ? v : null; } catch { return null; }
}

/* ================= 对话蒸馏（自动记忆） ================= */
let distillTimer = null;
function queueDistill(userText, aiText) {
  if (!API_KEY || !userText) return;
  const buf = readJson("distill_buf", []);
  buf.push({ u: userText.slice(0, 500), a: (aiText || "").slice(0, 500), t: Date.now() });
  writeJson("distill_buf", buf);
  if (buf.length >= 4 && !distillTimer) {
    distillTimer = setTimeout(() => { distillTimer = null; runDistill().catch(e => console.error("distill:", e.message)); }, 3000);
  }
}
async function runDistill() {
  const buf = readJson("distill_buf", []);
  if (!buf.length) return;
  writeJson("distill_buf", []);
  const convo = buf.map(x => `她: ${x.u}\n晤: ${x.a}`).join("\n");
  const out = await llm([{ role: "user", content:
    "从下面这段她与晤的对话中提取值得长期记住的信息（新事实、喜好、约定、重要情绪；寒暄客套不算）。" +
    '输出 JSON 数组（没有可记的就输出 []）。每项：{"type":"事件|喜好|约定|情绪|日常","content":"一句话，主语用「她」","tags":["…"],"importance":1-5,"emotion":{"valence":-1到1,"arousal":0到1}}。只输出 JSON。\n\n' + convo }], 700, 0.2);
  const cards = extractJsonArray(out);
  if (!cards) return;
  const all = listMem();
  for (const c of cards) {
    if (!c || !c.content) continue;
    if (all.some(x => !x.archived && (x.content.includes(c.content) || String(c.content).includes(x.content)))) continue;
    all.push(newCard(c, "distill"));
  }
  saveMem(all);
}

/* ================= dream 整理：合并陈旧碎片 ================= */
async function runDream() {
  if (!API_KEY) return { merged: 0, note: "未配置 Key" };
  const now = Date.now();
  const all = listMem();
  const old = all.filter(c => !c.archived && c.type !== "约定" && (c.importance || 3) <= 2 && effFreshness(c, now) < 0.3);
  if (old.length < 3) return { merged: 0, note: "还没有需要整理的旧记忆" };
  const out = await llm([{ role: "user", content:
    "把这些零散的旧记忆合并总结成 1-2 条更凝练的长期记忆（保留有意义的细节，合并重复主题）。" +
    '输出 JSON 数组，每项：{"type":"事件|喜好|约定|情绪|日常","content":"…","tags":[],"importance":1-5,"emotion":{"valence":0,"arousal":0}}。只输出 JSON。\n\n' +
    old.map(c => "- " + c.content).join("\n") }], 500, 0.3);
  const cards = extractJsonArray(out);
  if (!cards || !cards.length) return { merged: 0, note: "整理失败，稍后再试" };
  const oldIds = new Set(old.map(c => c.id));
  const next = all.map(c => oldIds.has(c.id) ? { ...c, archived: true } : c);
  for (const c of cards) if (c && c.content) next.push({ ...newCard(c, "dream"), importance: Math.min(5, Math.max(2, +c.importance || 3)) });
  saveMem(next);
  return { merged: old.length, into: cards.length };
}

/* ================= HTTP 工具 ================= */
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
async function readBody(req, limit = 15 * 1024 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("too large");
  }
  return body;
}
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8", ".heic": "image/heic", ".mp4": "video/mp4",
};

/* ================= 服务器 ================= */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    /* ---- 健康检查 ---- */
    if (req.method === "GET" && p === "/api/health") {
      sendJson(res, 200, { ok: true, hasKey: !!API_KEY, model: MODEL, dataDir: DATA_DIR, memories: listMem().filter(c => !c.archived).length });
      return;
    }

    /* ---- 数据云同步 ---- */
    if (req.method === "GET" && p === "/api/state") {
      const out = {};
      for (const k of STATE_KEYS) out[k] = readJson(k, null);
      sendJson(res, 200, out);
      return;
    }
    if (req.method === "PUT" && p.startsWith("/api/state/")) {
      const key = p.slice("/api/state/".length);
      if (!STATE_KEYS.includes(key)) { sendJson(res, 404, { error: "未知数据键" }); return; }
      const body = JSON.parse(await readBody(req, 5 * 1024 * 1024));
      writeJson(key, body);
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---- 记忆 API ---- */
    if (p === "/api/memories" && req.method === "GET") {
      const now = Date.now();
      const all = listMem().filter(c => !c.archived)
        .map(c => ({ ...c, eff: +effFreshness(c, now).toFixed(3) }))
        .sort((a, b) => (b.created || "").localeCompare(a.created || ""));
      sendJson(res, 200, all);
      return;
    }
    if (p === "/api/memories" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const card = newCard(body, "manual");
      if (!card.content) { sendJson(res, 400, { error: "内容不能为空" }); return; }
      const all = listMem(); all.push(card); saveMem(all);
      sendJson(res, 200, card);
      return;
    }
    if (p.startsWith("/api/memories/") && (req.method === "PUT" || req.method === "DELETE")) {
      const id = p.slice("/api/memories/".length);
      if (id === "dream" && req.method === "PUT") { sendJson(res, 200, await runDream()); return; }
      const all = listMem();
      const i = all.findIndex(c => c.id === id);
      if (i < 0) { sendJson(res, 404, { error: "没有这张记忆卡" }); return; }
      if (req.method === "DELETE") { all[i].archived = true; }
      else {
        const body = JSON.parse(await readBody(req));
        const keep = all[i];
        all[i] = { ...keep, ...newCard({ ...keep, ...body }, keep.source), id: keep.id, created: keep.created, freshness: keep.freshness, recalled: keep.recalled, last_recalled: keep.last_recalled };
      }
      saveMem(all);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (p === "/api/memories/dream" && req.method === "POST") { sendJson(res, 200, await runDream()); return; }

    /* ---- 八维驱动 ---- */
    if (p === "/api/drives" && req.method === "GET") {
      const now = Date.now();
      const d = tickDrives(loadDrives(), now);
      saveDrives(d);
      sendJson(res, 200, driveSnapshot(d, now));
      return;
    }
    if (p === "/api/drives" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const d = loadDrives();
      for (const k of Object.keys(DRIVE_META)) {
        if (typeof body[k] === "number") d.values[k] = clamp01(body[k] / 100);
      }
      saveDrives(d);
      sendJson(res, 200, driveSnapshot(d, Date.now()));
      return;
    }

    /* ---- 文件上传（base64 JSON，避免 multipart 依赖） ---- */
    if (p === "/api/upload" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (!body.data) { sendJson(res, 400, { error: "缺少文件数据" }); return; }
      const buf = Buffer.from(body.data, "base64");
      if (buf.length > 12 * 1024 * 1024) { sendJson(res, 413, { error: "文件超过 12MB" }); return; }
      const ext = (path.extname(body.name || "") || ".bin").toLowerCase().replace(/[^.\w]/g, "").slice(0, 8);
      const fname = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex") + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
      sendJson(res, 200, { ok: true, url: "/files/" + fname, size: buf.length });
      return;
    }
    if (req.method === "GET" && p.startsWith("/files/")) {
      const name = path.basename(p.slice("/files/".length));
      const fp = path.join(UPLOAD_DIR, name);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream", "Cache-Control": "public, max-age=31536000" });
        fs.createReadStream(fp).pipe(res);
        return;
      }
      res.writeHead(404); res.end(); return;
    }

    /* ---- 聊天：服务器负责拼 persona + 记忆 + 现状（缓存友好顺序），流式转发 ---- */
    if (p === "/api/chat" && req.method === "POST") {
      if (!API_KEY) { sendJson(res, 503, { error: "服务器未配置 LLM_API_KEY / DEEPSEEK_API_KEY" }); return; }
      const payload = JSON.parse(await readBody(req, 512 * 1024));
      const history = (payload.messages || []).filter(m => m && (m.role === "user" || m.role === "assistant")).slice(-30);
      if (!history.length) { sendJson(res, 400, { error: "缺少消息" }); return; }
      const lastUser = [...history].reverse().find(m => m.role === "user")?.content || "";

      /* 驱动引擎：先响应事件与时间流逝，再把当前状态告诉晤 */
      const now0 = Date.now();
      const dr = tickDrives(loadDrives(), now0);
      driveEvent(dr, lastUser, now0);
      saveDrives(dr);
      const snap = driveSnapshot(dr, now0);

      const mems = retrieveMemories(lastUser, 5);
      const memBlock = mems.length
        ? "【你的记忆】\n" + mems.map(c => `- (${c.type} · ${c.date}) ${c.content}`).join("\n")
        : "";
      const n = new Date();
      const days = Math.floor((n - SINCE) / 86400000) + 1;
      const todos = readJson("todos", []) || [];
      const pending = todos.filter(t => t && !t.done).slice(0, 5).map(t => t.text);
      const status = `【现状】今天是 ${n.getFullYear()}.${String(n.getMonth() + 1).padStart(2, "0")}.${String(n.getDate()).padStart(2, "0")}，你们在一起的第 ${days} 天。` +
        (pending.length ? `她今天清单上还没完成的事：${pending.join("、")}。` : "") +
        `你此刻的内在状态：${snap.top.name} ${snap.top.val}（${snap.top.say}）${snap.resting ? "，你有些疲惫，语气可以慵懒一点" : ""}。让语气自然贴合这种状态，但不要直接复述这些数值。`;

      const messages = [
        { role: "system", content: PERSONA },                       // 固定前缀 → 命中缓存
        ...(memBlock ? [{ role: "system", content: memBlock }] : []),
        { role: "system", content: status },
        ...history,
      ];

      const upstream = await fetch(API_BASE + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.8, max_tokens: 1024 }),
      });
      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 500);
        sendJson(res, upstream.status, { error: "上游模型返回错误", detail });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
      /* 边转发边攒出完整回复，供蒸馏用 */
      let acc = "", sseBuf = "";
      const dec = new TextDecoder();
      for await (const chunk of upstream.body) {
        res.write(chunk);
        sseBuf += dec.decode(chunk, { stream: true });
        const lines = sseBuf.split("\n"); sseBuf = lines.pop();
        for (const ln of lines) {
          const s = ln.trim();
          if (!s.startsWith("data:")) continue;
          const d = s.slice(5).trim();
          if (d === "[DONE]") continue;
          try { const t = JSON.parse(d).choices?.[0]?.delta?.content; if (t) acc += t; } catch {}
        }
      }
      res.end();
      queueDistill(lastUser, acc);
      return;
    }

    /* ---- 静态托管 ---- */
    if (req.method === "GET") {
      const name = p === "/" ? "index.html" : p === "/admin" ? "admin.html" : p.slice(1);
      const fp = path.join(__dirname, path.normalize(name));
      if (fp.startsWith(__dirname) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
        fs.createReadStream(fp).pipe(res);
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (e) {
    try { sendJson(res, 500, { error: String(e.message || e).slice(0, 300) }); } catch {}
  }
});

server.listen(PORT, () => {
  console.log(`晤 · With You v2  http://localhost:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}` + (API_KEY ? `  模型: ${MODEL}` : "  （未配置 Key，聊天为演示模式）"));
});
