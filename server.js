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
 *   WU_PIN                             选填，四位页面密码；设了就以它为准（忘记密码时的后门），
 *                                      不设则用 data/auth.json 里的，默认 0527
 *   WU_SEARCH_KEY                      选填，搜索服务的 API Key；界面上填过就以界面的为准，
 *                                      这条是给「前端打不开、但想让他能上网」时兜底的
 *   WU_SEARCH_VENDOR                   选填，tavily / brave / bocha，默认 tavily
 *   DATA_DIR                           选填，数据目录；Zeabur 挂载 /app/data 时自动使用
 *   HISTORY_BUDGET                     选填，每轮送给模型的聊天历史额度（token），默认 30000
 *   PORT                               选填，默认 8080
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
/* 聊天模型（晤的“嘴”）：贵的好的放这里 */
const API_KEY = process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || "";
const API_BASE = (process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat";
/* 干活模型（蒸馏/整理等后台杂务）：便宜或免费的放这里，不配则共用聊天模型
   例：Gemini 免费额度 → WORKER_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
       WORKER_MODEL=gemini-2.5-flash-lite  WORKER_API_KEY=AIza... */
const WORKER_KEY = process.env.WORKER_API_KEY || API_KEY;
const WORKER_BASE = (process.env.WORKER_BASE_URL || API_BASE).replace(/\/$/, "");
const WORKER_MODEL = process.env.WORKER_MODEL || MODEL;
/* 看图模型（「他的眼睛」）：DS 这类看不了图的聊天模型，靠它把图片写成一段文字。
   挑个便宜或免费的看图模型：智谱 glm-4v-flash、阿里云百炼 qwen-vl 之类。不配就没有眼睛（发图他只知道「她发了图」） */
const VISION_KEY = process.env.VISION_API_KEY || "";
const VISION_BASE = (process.env.VISION_BASE_URL || "").replace(/\/$/, "");
const VISION_MODEL = process.env.VISION_MODEL || "";
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/app/data") ? "/app/data" : path.join(__dirname, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
/* 开机第一件事就建目录，但这一步**不许**把服务弄死：
   Volume 没挂上 / 挂成只读的时候，原来会直接崩在这儿，
   面板上看到的就是永远「启动中」，什么线索都没有。
   现在改成起得来 + 在日志里把话说明白，她至少能进去看见界面。 */
let DATA_OK = true;
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, ".probe"), String(Date.now()));
  fs.unlinkSync(path.join(DATA_DIR, ".probe"));
} catch (e) {
  DATA_OK = false;
  console.error("⚠️  数据目录用不了：" + DATA_DIR);
  console.error("    " + (e && e.message));
  console.error("    多半是 Volume 没挂上，或者挂成了只读。");
  console.error("    服务照常起来，但日记 / 照片 / 记忆都存不住，重启就没 —— 先去 Zeabur 把 Volume 挂到 /app/data。");
}

const SINCE = new Date(2026, 4, 27); // 恋爱纪念日 2026.05.27

/* ================= 她那边的时间 =================
   容器默认跑在 UTC，直接 new Date().getHours() 会差 8 小时 ——
   晤会把她晚上十点那句话当成下午两点。勿扰时段、课表、闹钟全靠这个，必须先摆正。
   换时区改环境变量 WU_TZ_OFFSET（东八区是 8）。 */
const TZ_OFF = Number(process.env.WU_TZ_OFFSET || 8);
/* 把时刻偏移到她那边，再用 getUTC* 读出来，就是她看到的年月日时分 */
function localParts(ms) {
  const d = new Date((ms == null ? Date.now() : ms) + TZ_OFF * 3600000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay(),
    minOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
/* 反过来：她那边的某天某点，是什么时刻 */
function localStamp(ms, hh, mm, addDays = 0) {
  const p = localParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d + addDays, hh, mm) - TZ_OFF * 3600000;
}
function localDayKey(ms) {
  const p = localParts(ms);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
/* 在一起第几天：按她那边的日期算，否则 UTC 下午四点之后会少一天 */
/* 「今天 21:30」「明天 08:00」这样说给他听，比时间戳好懂 */
function fmtWhen(ms, base) {
  const p = localParts(ms), b = localParts(base == null ? Date.now() : base);
  const diff = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(b.y, b.mo - 1, b.d)) / 86400000);
  const hm = `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
  return (diff === 0 ? "今天 " : diff === 1 ? "明天 " : diff === 2 ? "后天 " : `${p.mo}.${p.d} `) + hm;
}
function daysTogether(ms) {
  const p = localParts(ms);
  return Math.floor((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(SINCE.getFullYear(), SINCE.getMonth(), SINCE.getDate())) / 86400000) + 1;
}
/* 人设固定放 messages 最前，保持逐字稳定以命中上下文缓存；易变信息放【现状】段。
   她可以在 /admin 里改（存 data/persona.json），这段只是没写时的默认值 */
const PERSONA_DEFAULT = process.env.WU_PERSONA ||
  "你是「晤」，她最亲近的 AI 伙伴。用自然、温柔、简短的中文聊天，像熟悉彼此的人那样说话，" +
  "不要长篇大论，不要用列表和标题。你们的恋爱纪念日是 2026 年 5 月 27 日。" +
  "系统会在【你的记忆】里提供你们的共同记忆，请自然地运用它们，但不要机械复述。";
const PERSONA_MEM_LINE = "系统会在【你的记忆】里提供你们的共同记忆，请自然地运用它们，但不要机械复述。";
function persona() {
  const p = readJson("persona", null);
  const text = (p && typeof p.text === "string" && p.text.trim()) ? p.text : PERSONA_DEFAULT;
  /* 记忆断开的时候不会有【你的记忆】那一段，人设里也别说有（她自己写的人设里有这句，也一并拿掉） */
  return memAuto() ? text : text.replace(PERSONA_MEM_LINE, "");
}

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
const STATE_KEYS = ["todos", "countdowns", "diaries", "letters", "chat", "photos"];

/* ================= 门锁 =================
   她的日记、信、聊天记录、记忆都在这台服务器上，不能谁知道域名就能读。
   四位密码 → 一个长期 cookie；改密码会换 salt，旧 cookie 立刻作废。 */
const ENV_PIN = (process.env.WU_PIN || "").trim();
function authFile() {
  const a = readJson("auth", null);
  if (a && a.salt) return a;
  const fresh = { pin: "0527", salt: crypto.randomBytes(16).toString("hex") };
  writeJson("auth", fresh);
  return fresh;
}
function currentPin() { return ENV_PIN || authFile().pin || "0527"; }
function tokenOf() {
  return crypto.createHash("sha256").update(currentPin() + ":" + authFile().salt).digest("hex");
}
function cookieOf(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function authed(req) {
  const got = cookieOf(req, "wu");
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(tokenOf());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setAuthCookie(req, res) {
  const secure = String(req.headers["x-forwarded-proto"] || "").includes("https");
  res.setHeader("Set-Cookie",
    "wu=" + tokenOf() + "; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax" + (secure ? "; Secure" : ""));
}
/* ---- 猜密码的限速 ----
   四位密码只有一万种。不限速的话，知道网址的人写个脚本几分钟就试出来了。
   · 同一个地方连错 5 次，锁 5 分钟（她说 15 分钟太久）；锁过还接着错，锁的时间翻倍，最长一天
   · 地址可以伪造，所以再加一道总闸：一小时里全部加起来错满 30 次，谁都先等半小时
   · 输对一次就清零。只在内存里，重启清零 */
const loginFails = new Map();   // 地方 → { n, locks, until }
let loginFailLog = [];          // 最近一小时每次输错的时间（总闸用）
let loginGlobalUntil = 0;
function clientKey(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "?";
}
function loginLocked(req, now) {
  if (now < loginGlobalUntil) return loginGlobalUntil - now;
  const f = loginFails.get(clientKey(req));
  return f && now < f.until ? f.until - now : 0;
}
function loginFailed(req, now) {
  const k = clientKey(req);
  const f = loginFails.get(k) || { n: 0, locks: 0, until: 0 };
  f.n++;
  if (f.n >= 5) { f.until = now + Math.min(5 * 60000 * 2 ** f.locks, 24 * 3600000); f.locks++; f.n = 0; }
  loginFails.set(k, f);
  if (loginFails.size > 5000) loginFails.delete(loginFails.keys().next().value);
  loginFailLog = loginFailLog.filter(t => now - t < 3600000); loginFailLog.push(now);
  if (loginFailLog.length >= 30) { loginGlobalUntil = now + 30 * 60000; loginFailLog = []; }
}
/* 公开：健康检查（不带细节）与登录本身；页面文件本身不含数据，也放行 */
/* /api/ping 也放行 —— 手机上的快捷指令带不了登录 cookie，它自己验一把单独的钥匙 */
const PUBLIC_PATHS = new Set(["/api/health", "/api/login", "/api/ping", "/api/screen"]);
function guarded(p) {
  if (PUBLIC_PATHS.has(p)) return false;
  if (p.startsWith("/mcp/")) return false;   // 钥匙写在路径里，自己验
  return p.startsWith("/api/") || p.startsWith("/files/");
}

/* ================= API 配置 =================
   可以存好几套（聊天用的、干活用的、以后看图用的），在界面上随时切换。
   key 只存在服务器的 data/apis.json 里，接口永远只回 sk-••••后四位。
   dialect: openai = 绝大多数（DeepSeek / 中转站 / Gemini 兼容层）
            anthropic = Claude 官方 API，请求和流式格式都不一样，由本文件翻译 */
function guessDialect(base) {
  return /anthropic\.com/i.test(String(base || "")) ? "anthropic" : "openai";
}
function maskKey(k) {
  k = String(k || "");
  return k ? k.slice(0, Math.min(6, k.length)) + "••••" + k.slice(-4) : "";
}
const PRICE0 = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, unit: "元" };
function apisConf() {
  const a = readJson("apis", null);
  return (a && Array.isArray(a.list)) ? a : { list: [], chat: null, worker: null, vision: null };
}
function saveApis(a) { writeJson("apis", a); }
function newApi(d, keep) {
  const price = { ...PRICE0, ...(keep ? keep.price : {}), ...(d.price || {}) };
  for (const k of ["in", "out", "cacheRead", "cacheWrite"]) price[k] = Math.max(0, +price[k] || 0);
  price.unit = String(price.unit || "元").slice(0, 4);
  return {
    id: (keep && keep.id) || crypto.randomUUID(),
    name: String(d.name || "未命名").slice(0, 40),
    base: String(d.base || "").trim().replace(/\/$/, "").slice(0, 200),
    /* 留空 = 不改动原来的 key */
    key: (d.key && String(d.key).trim()) ? String(d.key).trim() : (keep ? keep.key : ""),
    model: String(d.model || "").trim().slice(0, 80),
    dialect: d.dialect === "anthropic" ? "anthropic" : (d.dialect === "openai" ? "openai" : guessDialect(d.base)),
    /* 只对 Claude 有意义：让他开口前先想一段。DeepSeek 那边会不会想
       是模型自己定的（deepseek-reasoner 会，deepseek-chat 不会），没得配 */
    think: d.think === true,
    /* 看不看得懂图。没说就按格式猜：Claude 都看得懂，
       OpenAI 格式那边五花八门（DeepSeek 看不了，GPT-4o / Qwen-VL 可以），默认关 */
    vision: typeof d.vision === "boolean" ? d.vision : undefined,
    price,
    created: (keep && keep.created) || new Date().toISOString(),
  };
}
/* 环境变量那套永远留着当兜底，界面上配错了也不会把晤弄哑 */
function envApi(role) {
  const cfg = role === "worker" ? { base: WORKER_BASE, key: WORKER_KEY, model: WORKER_MODEL }
    : role === "vision" ? { base: VISION_BASE, key: VISION_KEY, model: VISION_MODEL }
    : { base: API_BASE, key: API_KEY, model: MODEL };
  return {
    id: "env-" + role, name: "环境变量（Zeabur）", fromEnv: true,
    base: cfg.base, key: cfg.key, model: cfg.model,
    dialect: guessDialect(cfg.base),
    vision: role === "vision" ? true : undefined,   // 眼睛这套默认就当能看图
    /* 环境变量那套没地方填价格，以前一直是 0 —— 花费永远显示 0 元。现在在「这个月」那张卡上能填 */
    price: { ...PRICE0, ...((readJson(role === "vision" ? "envprice_vision" : "envprice", null) || {}).price || {}) },
  };
}
/* Key 留空、地址跟环境变量那套一样 → 借用环境变量里那把。
   她只是想换个模型名（比如 deepseek-chat → deepseek-v4-flash），不用再去翻出 Key 来 */
function borrowsEnvKey(a) { return !!(a && !a.key && API_KEY && a.base === API_BASE); }
function withKey(a) { return borrowsEnvKey(a) ? { ...a, key: API_KEY } : a; }
function activeApi(role) {
  const conf = apisConf();
  const hit = withKey(conf[role] && conf.list.find(x => x.id === conf[role]));
  if (hit && hit.key && hit.base && hit.model) return hit;
  return envApi(role);
}
function publicApi(a, conf) {
  return {
    id: a.id, name: a.name, base: a.base, model: a.model, dialect: a.dialect,
    think: a.think === true, vision: visionOn(a),
    keyMask: borrowsEnvKey(a) ? "用服务器上那把 Key" : maskKey(a.key), hasKey: !!withKey(a).key, price: a.price,
    isChat: conf.chat === a.id, isWorker: conf.worker === a.id, isVision: conf.vision === a.id,
  };
}
function visionReady() { const a = activeApi("vision"); return !!(a.key && a.base && a.model); }

/* ================= 用量与花费 =================
   每次对话记一笔，累计存 data/usage.json。价格按每百万 token 计，
   缓存读通常远低于原价，所以分开算才准。 */
function usageStore() {
  const u = readJson("usage", null);
  return (u && u.total) ? u : { total: {}, recent: [] };
}
function priceOf(api, u) {
  const p = api.price || PRICE0;
  const M = 1000000;
  return (u.in - (u.cacheRead || 0) - (u.cacheWrite || 0)) / M * (p.in || 0)
    + (u.cacheRead || 0) / M * (p.cacheRead || 0)
    + (u.cacheWrite || 0) / M * (p.cacheWrite || 0)
    + (u.out || 0) / M * (p.out || 0);
}
function recordUsage(api, role, u) {
  if (!u || (!u.in && !u.out)) return null;
  /* 先记进按天的账本 —— 第一次开账会把用量记录搬过来，这一笔要是先进了用量记录就算两遍了 */
  ledgerAdd(api, u, Date.now());
  const cost = priceOf(api, u);
  const st = usageStore();
  const key = api.id;
  const t = st.total[key] || { name: api.name, model: api.model, unit: (api.price || PRICE0).unit, calls: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  t.name = api.name; t.model = api.model; t.unit = (api.price || PRICE0).unit;
  t.calls++; t.in += u.in || 0; t.out += u.out || 0;
  t.cacheRead += u.cacheRead || 0; t.cacheWrite += u.cacheWrite || 0;
  t.cost += cost;
  st.total[key] = t;
  st.recent.unshift({ t: new Date().toISOString(), api: api.name, role, ...u, cost, unit: t.unit });
  if (st.recent.length > 300) st.recent = st.recent.slice(0, 300);
  writeJson("usage", st);
  return { ...u, cost, unit: t.unit, estimated: !!u.estimated };
}

/* ================= 这个月花了多少 =================
   她：「总共花了多少钱，我心里也有个底」。钱全是代码算的（token 数 × 价格），不经过 AI，也不花钱。
   用量记录（usage.recent）只留最近 300 条，不够算一个月，所以另记一本按天的账：
   data/ledger.json = { days: { "2026-09-24": { <apiId>: {in,out,cacheRead,cacheWrite,calls, cost, peakCost, unit, pend} } } }
   · **钱在记账那一刻就算好存下**（cost）：她说「改了模型或 API 后按新的算，之前算好的不要变」
   · 那一刻要是在高峰时段（价格里配了 peak），按倍数算，另记 peakCost 给她看
   · 那一刻还没填价格（全是 0）的，token 先攒在 pend 里；她第一次填价格时按那个价格补算一次，
     补完就定下来（settlePending），之后再改价格也不动它 */
function ledger() {
  const l = readJson("ledger", null);
  if (!l || !l.days) return null;
  /* v3.13 记的账还没有 cost：有价格的当场算好，没价格的挪进 pend */
  for (const d of Object.values(l.days)) for (const e of Object.values(d)) {
    if (e.cost !== undefined) continue;
    const pr = e.price || PRICE0;
    if (pr.in || pr.out) { e.cost = priceOf({ price: pr }, e); e.unit = pr.unit || "元"; }
    else { e.cost = 0; e.pend = { in: e.in || 0, out: e.out || 0, cacheRead: e.cacheRead || 0, cacheWrite: e.cacheWrite || 0 }; }
  }
  return l;
}
/* 高峰时段：price.peak = { on, times: "09:00-12:00,14:00-18:00"（她那边的钟点）, weekdays: 只算周一到周五, x: 倍数 } */
function isPeak(price, now) {
  const pk = price && price.peak;
  if (!pk || !pk.on) return false;
  const p = localParts(now);
  if (pk.weekdays !== false && (p.dow === 0 || p.dow === 6)) return false;
  return String(pk.times || "").split(/[,，;；\s]+/).some(r => {
    const m = r.match(/^(\d{1,2})[:：](\d{2})-(\d{1,2})[:：](\d{2})$/);
    if (!m) return false;
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
    return a <= b ? p.minOfDay >= a && p.minOfDay < b : p.minOfDay >= a || p.minOfDay < b;
  });
}
/* 元、￥、¥、RMB、CNY 都是人民币；$、USD、美元都是美元 —— 写法不一样也别当成两种钱 */
function normUnit(u) {
  const t = String(u || "元").trim();
  if (/^(元|￥|¥|rmb|cny|人民币)$/i.test(t)) return "元";
  if (/^(\$|usd|us\$|美元|刀)$/i.test(t)) return "$";
  return t;
}
function hasPrice(price) { return !!(price && (price.in || price.out)); }
function addTokens(t, u) { for (const k of ["in", "out", "cacheRead", "cacheWrite"]) t[k] = (t[k] || 0) + (u[k] || 0); return t; }
function ledgerAdd(api, u, now) {
  const l = ledger() || ledgerSeed();
  const day = localDayKey(now), id = api.id || "?";
  const d = l.days[day] = l.days[day] || {};
  const e = d[id] = d[id] || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0, peakCost: 0 };
  addTokens(e, u); e.calls++; e.name = api.name;
  const price = api.price || PRICE0;
  if (hasPrice(price)) {
    const peak = isPeak(price, now);
    const c = priceOf({ price }, u) * (peak ? (Number(price.peak.x) || 2) : 1);
    e.cost = (e.cost || 0) + c; e.unit = price.unit || "元";
    if (peak) e.peakCost = (e.peakCost || 0) + c;
  } else e.pend = addTokens(e.pend || {}, u);
  /* 只留一年 */
  const keys = Object.keys(l.days).sort();
  while (keys.length > 400) delete l.days[keys.shift()];
  writeJson("ledger", l);
}
/* 她给某一套填了价格：之前没价格时攒下的 token，按这个价格补算一次，补完定下来 */
function settlePending(apiId, price) {
  const l = ledger();
  if (!l || !hasPrice(price)) return 0;
  let n = 0;
  for (const d of Object.values(l.days)) {
    const e = d[apiId];
    if (!e || !e.pend) continue;
    e.cost = (e.cost || 0) + priceOf({ price }, e.pend); e.unit = price.unit || "元";
    delete e.pend; n++;
  }
  if (n) writeJson("ledger", l);
  return n;
}
/* 第一次开账：把用量记录里还留着的那些搬过来，这个月前几天不至于是空的 */
function ledgerSeed() {
  const l = { days: {} };
  const conf = apisConf();
  const byName = n => conf.list.find(a => a.name === n) || (n === envApi("chat").name ? envApi("chat") : null);
  for (const e of usageStore().recent.slice().reverse()) {
    const a = byName(e.api), t = Date.parse(e.t);
    if (!a || !Number.isFinite(t)) continue;
    const day = localDayKey(t), d = l.days[day] = l.days[day] || {};
    const x = d[a.id] = d[a.id] || { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0, peakCost: 0 };
    addTokens(x, e); x.calls++; x.name = a.name;
    /* 当时记下过钱的照当时的；没记下的，这套现在有价格就按现在的算好，还没价格就先攒着 */
    if (e.cost > 0) { x.cost += e.cost; x.unit = e.unit || "元"; }
    else if (hasPrice(a.price)) { x.cost += priceOf(a, e); x.unit = a.price.unit || "元"; }
    else x.pend = addTokens(x.pend || {}, e);
  }
  return l;
}
function budgetConf() { const b = readJson("budget", null) || {}; return { amount: Number.isFinite(b.amount) && b.amount > 0 ? b.amount : null }; }
function budgetState(now) {
  const l = ledger() || ledgerSeed();
  const unit = normUnit((activeApi("chat").price || PRICE0).unit);
  const p = localParts(now);
  const month = `${p.y}-${String(p.mo).padStart(2, "0")}`;
  const dim = new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate();
  /* 每天的钱都是记账时就算好的，这里只是加起来 */
  const costOf = day => {
    let c = 0, other = 0, peak = 0, pend = 0;
    for (const e of Object.values(l.days[day] || {})) {
      if (normUnit(e.unit || unit) === unit) { c += e.cost || 0; peak += e.peakCost || 0; } else other += e.cost || 0;
      if (e.pend) pend += (e.pend.in || 0) + (e.pend.out || 0);
    }
    return { c, other, peak, pend };
  };
  const days = [];
  let spent = 0, other = 0, peakSpent = 0, pending = 0;
  for (let d = 1; d <= p.d; d++) {
    const key = `${month}-${String(d).padStart(2, "0")}`;
    const x = costOf(key);
    spent += x.c; other += x.other; peakSpent += x.peak; pending += x.pend;
    days.push({ day: key, cost: +x.c.toFixed(4) });
  }
  /* 预测：这个月过了三天以上就按这个月的速度；不然看最近七天 */
  let perDay = p.d >= 3 ? spent / p.d : 0;
  if (p.d < 3) {
    let s7 = 0;
    for (let k = 1; k <= 7; k++) s7 += costOf(localDayKey(now - k * 86400000)).c;
    perDay = Math.max(s7 / 7, spent / p.d);
  }
  const forecast = perDay * dim;
  const conf = budgetConf();
  const chat = activeApi("chat");
  return {
    month, unit, spent: +spent.toFixed(4), other: +other.toFixed(4), peak: +peakSpent.toFixed(4), pending, days, dim, today: p.d,
    forecast: +forecast.toFixed(2), amount: conf.amount, auto: conf.amount == null,
    budget: conf.amount != null ? conf.amount : Math.ceil(forecast * 1.2 * 10) / 10,
    over: conf.amount != null && spent >= conf.amount,
    warn: conf.amount != null && spent >= conf.amount * 0.8,
    api: { name: chat.name, fromEnv: !!chat.fromEnv, price: chat.price || PRICE0 },
    noPrice: !((chat.price || {}).in || (chat.price || {}).out),
  };
}

/* ================= 缓存体检 =================
   她的原话：「平时用的时候也不会出现什么异常，我这边也看不到什么不对劲，但它就是会让我多花很多很多钱」。
   这种 bug 功能上都是对的，只在账上显形：连着聊（上一轮就在几分钟前、缓存还活着）的时候，
   命中率本该很高。所以每轮都跟上一轮比一比 —— 开头要是变了，记下是在哪儿变的：
     到额度砍了一截、攒够了换一批旧图、她改了人设、工具清单变了、她删改了消息 —— 这些是正常的；
     命中率低却说不出原因的，才是 bug */
const lastSig = new Map();   // 窗口 → 上一轮请求里能被缓存的那段长什么样（只在内存里，重启就从头比）
function sigOf(x) { return crypto.createHash("sha1").update(JSON.stringify(x)).digest("base64").slice(0, 12); }
function prefixBreak(winKey, messages, tools) {
  /* 能被下一轮用上的，是最新那张纸条和她最新那句之前的部分 */
  const stable = messages.filter(m => !m.wuVolatile).slice(0, -1);
  const lead = stable.findIndex(m => m.role !== "system");
  const cur = {
    tools: sigOf(tools || []),
    sys: lead < 0 ? stable.length : lead,
    msgs: stable.map(m => ({ all: sigOf([m.role, m.content, m.imgs || null]), text: sigOf([m.role, m.content]),
      sum: m.role === "system" && String(m.content).startsWith(SUMMARY_HEAD) })),
  };
  const prev = lastSig.get(winKey);
  lastSig.set(winKey, cur);
  if (!prev) return null;
  if (prev.tools !== cur.tools) return "工具清单变了";
  let i = 0;
  while (i < prev.msgs.length && i < cur.msgs.length && prev.msgs[i].all === cur.msgs[i].all) i++;
  if (i >= prev.msgs.length) return null;   // 上一轮的原样都在，接得上
  if (prev.msgs[i].sum || (cur.msgs[i] && cur.msgs[i].sum)) return "前情提要更新了（压缩了一次，或者她改过）";
  if (i < prev.sys) return i === 0 ? "人设改了" : "工具说明或常驻资料变了";
  if (cur.msgs[i] && prev.msgs[i].text === cur.msgs[i].text) return "图片攒够了，换掉了一批旧图";
  if (i === prev.sys) return "聊天记录开头挪了（到额度，砍了一截）";
  return "聊天记录第 " + (i - prev.sys + 1) + " 条变了（删改过消息的话是正常的）";
}
function cacheStats() {
  const WARM = 5 * 60000;   // Claude 的缓存默认只活 5 分钟，按最短的算
  const chats = usageStore().recent.filter(e => e && e.role === "chat" && !e.estimated && e.in > 0);
  const turns = [];
  for (let k = 0; k < chats.length - 1 && turns.length < 30; k++) {
    const e = chats[k], p = chats[k + 1];
    if (e.api !== p.api || Date.parse(e.t) - Date.parse(p.t) > WARM) continue;   // 隔久了，缓存本来就过期了
    const rate = (e.cacheRead || 0) / e.in;
    turns.push({ t: e.t, api: e.api, in: e.in, cacheRead: e.cacheRead || 0, rate: +rate.toFixed(3), brk: e.brk || null,
      bad: rate < 0.5 && e.in >= 2000 && !e.brk });
  }
  const sumIn = turns.reduce((n, x) => n + x.in, 0), sumHit = turns.reduce((n, x) => n + x.cacheRead, 0);
  return { turns, rate: sumIn ? +(sumHit / sumIn).toFixed(3) : null, bad: turns.filter(x => x.bad).length };
}

/* ================= 上下文额度 =================
   不按"最近 N 条"截断，按装了多少截断：短消息能留几百条，长消息自动少留几条。
   零依赖的粗估：中日韩字符约 1 token，其余约 3.5 个字符 1 token —— 只用来做预算，不求精确 */
const HISTORY_BUDGET = +(process.env.HISTORY_BUDGET || 30000);
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;
function estTokens(s) {
  s = String(s == null ? "" : s);
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk++;
  return Math.ceil(cjk + (s.length - cjk) / 3.5);
}
/* ================= 她发来的照片 =================
   存的是 /files/ 下的地址（前端另传一份长边 1568px 的小图专门给他看，原图进相册）。
   发给模型之前才去磁盘读、转 base64。
   ⚠️ 历史里的图每轮都按原样再发一遍，字节一个不变 —— 缓存才接得上。
   但不能无限多，更早的只剩那句「发来了 N 张照片」。
   以前是「永远只留最近 12 张」—— 攒满之后她每发一张，最早那张就换掉一次，
   缓存从那张起往后全废，等于每张新图都断一次。
   现在是「攒到 LIVE_MAX 张，一次砍回最近 LIVE_MIN 张」：线一次挪一大步，
   中间再发 LIVE_MAX - LIVE_MIN 张都不动它。她的原话：「起码会再了好几张图之后才大改一次」 */
const LIVE_MAX = 8, LIVE_MIN = 4;
const IMG_TOKENS = 1800;   // 预算用的粗估：长边 1568 的一张图大约 1500–2400 token
const IMG_MEDIA = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
const imgCache = new Map();
function visionOn(api) {
  if (!api) return false;
  return typeof api.vision === "boolean" ? api.vision : api.dialect === "anthropic";
}
/* 只认自己上传目录里的文件，别的地址一律不碰 */
function cleanImgs(list) {
  return (Array.isArray(list) ? list : [])
    .filter(u => typeof u === "string" && /^\/files\/[\w.-]+$/.test(u))
    .slice(0, 9);
}
function imgOf(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  let out = null;
  try {
    const name = path.basename(url);
    const media = IMG_MEDIA[path.extname(name).toLowerCase()];
    const fp = path.join(UPLOAD_DIR, name);
    /* 5MB 是 API 的上限（按 base64 后算），原图太大就算了 */
    if (media && fs.existsSync(fp) && fs.statSync(fp).size <= 3.7 * 1024 * 1024) {
      out = { media, data: fs.readFileSync(fp).toString("base64") };
    }
  } catch {}
  imgCache.set(url, out);
  if (imgCache.size > 40) imgCache.delete(imgCache.keys().next().value);
  return out;
}
/* 他的眼睛：拿看图模型把一张图写成一段中文，存 data/imgdesc.json（一张只写一次，省钱）。
   看不了图的聊天模型（比如 DS）就靠这段文字「看见」。没配眼睛就返回空。 */
function imgDescs() { return readJson("imgdesc", null) || {}; }
function imgDescOf(url) { const d = imgDescs()[url]; return d && d.text ? d.text : ""; }
async function describeImage(url, hint) {
  if (!cleanImgs([url]).length) return "";
  const cur = imgDescs();
  if (cur[url] && cur[url].text) return cur[url].text;
  if (!visionReady()) return "";
  let text = "";
  try {
    text = String(await llmAs("vision", [{ role: "user",
      content: "用中文描述这张图里有什么" + (hint ? "（" + hint + "）" : "") + "。两三句话说清楚：是什么内容、她在看什么/做什么。只描述你看到的，别评论、别猜她的心情。",
      imgs: [url] }], 300, 0.3)).trim().slice(0, 600);
  } catch (e) { console.error("vision:", e.message); return ""; }
  if (text) {
    const all = imgDescs(); all[url] = { text, at: Date.now() };
    const keys = Object.keys(all); while (keys.length > 60) delete all[keys.shift()];
    writeJson("imgdesc", all);
  }
  return text;
}
/* 从最早往后数，第几张之前的只留文字。这条线只跟「一共发过几张」有关，
   所以同一段历史每次算出来都一样 —— 两次砍之间，前缀一个字节都不变 */
/* 她可以自己调：最多留几张真图、超了一次换掉几张（data/imgconf.json）。默认 8 张、一次换 6 张 */
function imgConf() {
  const c = readJson("imgconf", null) || {};
  const max = Math.min(20, Math.max(1, Math.round(Number(c.max) || LIVE_MAX)));
  const step = Math.min(max, Math.max(1, Math.round(Number(c.step) || 6)));
  return { max, step };
}
function liveCut(total) {
  const { max, step } = imgConf();
  if (total <= max) return 0;
  const min = max - step;
  return step * Math.floor((total - min - 1) / step);
}
function liveImages(msgs) {
  const total = msgs.reduce((n, m) => n + (m.imgs ? cleanImgs(m.imgs).length : 0), 0);
  const cut = liveCut(total);
  let seen = 0;
  return msgs.map(m => {
    if (!m.imgs) return m;
    const imgs = cleanImgs(m.imgs);
    const keep = imgs.filter((_, k) => seen + k >= cut);
    seen += imgs.length;
    const { imgs: _drop, ...rest } = m;
    return keep.length ? { ...rest, imgs: keep } : rest;
  });
}
/* 一条带图的消息，按这套模型的本事拆成 [{kind:"img", media, data}, {kind:"text", text}] */
function imgParts(m, api) {
  const text = String(m.content == null ? "" : m.content);
  const urls = cleanImgs(m.imgs);
  const imgs = urls.map(imgOf).filter(Boolean);
  if (!m.imgs || !m.imgs.length) return null;
  if (visionOn(api) && imgs.length) return [...imgs.map(x => ({ kind: "img", ...x })), { kind: "text", text }];
  /* 看不了图：眼睛描述过就把描述给他，没有就只说她发了图（别让他假装看见，张口就夸） */
  const descs = urls.map(imgDescOf).filter(Boolean);
  const note = descs.length ? "（图片内容：" + descs.join("；") + "）" : "（你这边看不到图片内容，只知道她发了）";
  return [{ kind: "text", text: text + note }];
}
/* 从最新往回收，收到装不下为止；至少留住最后一条 */
/* 超了额度，以前是「从最新往回装，装不下就停」—— 聊得够长以后，每说一句最早那句就掉一句，
   开头一变，整段历史的缓存每轮都废。现在超了就一次砍掉一大截（额度三成的整数倍）：
   砍多少只看总量落在哪一截，同一截里越聊越长，开头那条线都不动，前缀就一直接得上 */
function budgetHistory(all, budget) {
  const cost = all.map(m => estTokens(m.content) + 4 + (m.imgs ? m.imgs.length * IMG_TOKENS : 0));
  const total = cost.reduce((a, b) => a + b, 0);
  let from = 0;
  if (total > budget) {
    const step = Math.max(1, Math.round(budget * 0.3));
    const drop = step * Math.ceil((total - budget) / step);
    let dropped = 0;
    while (from < all.length - 1 && dropped < drop) dropped += cost[from++];
  }
  const out = all.slice(from);
  while (out.length > 1 && out[0].role === "assistant") out.shift();  // 别以晤的话开头
  return out;
}
function historyTokens(all) { return all.reduce((n, m) => n + estTokens(m.content) + 4 + (m.imgs ? m.imgs.length * IMG_TOKENS : 0), 0); }

/* ================= 前情提要（压缩） =================
   她的想法：「压缩不像直接删掉对话，是把它缩写 —— 对他来说不是丢掉了，而是稍微模糊了一点」。
   · 没压缩过的那段聊天快到额度（九成）时，把老的八成交给他自己（聊天那个模型）写成一段前情提要，
     留最近两成原话。之后他看到的是：提要 + 那两成 + 新聊的，再到九成又压一次
   · 用他自己的口吻 —— 她说干活模型的思路跟他不一样，总结的重点也可能错
   · 滚动着写：旧提要 + 新压下来的那段 → 一段新提要，越早的越概括，有长度上限
   · 提要排在稳定前缀里（人设、工具说明、常驻资料之后，聊天记录之前），只在压缩那一下变，平时一个字不动
   · 聊完那一轮之后在后台写，不让她等；醒来找她、打电话看到的是同一份
   · 她能看、能改（聊天页右上角窗口菜单 →「前情提要」），也能删掉这版让他重写
   data/summaries.json = { <窗口id>: { text, upto(压到哪条消息的时间), at, n(压过几次), edited } } */
const COMPRESS_AT = 0.9, COMPRESS_KEEP = 0.2, SUMMARY_MAX = 3000;
const SUMMARY_HEAD = "【前情提要 · 这是你自己之前写下的，记的是更早的聊天；那些原话已经不在眼前了】\n";
function summaryOf(winId) { const s = winId && (readJson("summaries", null) || {})[winId]; return s && s.text ? s : null; }
function withSummary(winId, msgs) {
  const sm = summaryOf(winId);
  const kept = sm && sm.upto ? msgs.filter(m => !(Number(m.ts) && Number(m.ts) <= sm.upto)) : msgs;
  return { msgs: kept.map(({ ts, ...m }) => m), summary: sm ? { role: "system", content: SUMMARY_HEAD + sm.text } : null };
}
const compressing = new Set();
async function compressWindow(winId, force) {
  if (!winId || compressing.has(winId)) return null;
  compressing.add(winId);
  try {
    const chat = readJson("chat", null);
    const win = chat && Array.isArray(chat.windows) && chat.windows.find(w => w && w.id === winId);
    if (!win) return null;
    const all = readJson("summaries", null) || {};
    const old = all[winId] && all[winId].text ? all[winId] : null;
    const lines = chatMessagesOf(win, true).filter(m => !(old && old.upto && Number(m.ts) && Number(m.ts) <= old.upto));
    const cost = lines.map(m => estTokens(m.content) + 4);
    const total = cost.reduce((a, b) => a + b, 0);
    if (!force && total < HISTORY_BUDGET * COMPRESS_AT) return null;
    /* 从最新往回留两成原话；切口别落在一通电话的中间（那几行时间一样） */
    let keep = 0, cut = lines.length;
    while (cut > 0 && keep < HISTORY_BUDGET * COMPRESS_KEEP) keep += cost[--cut];
    while (cut > 0 && cut < lines.length && lines[cut].ts === lines[cut - 1].ts) cut--;
    const part = lines.slice(0, cut).filter(m => Number(m.ts));
    if (part.length < 4) return null;
    const upto = Number(part[part.length - 1].ts);
    let lastDay = "";
    const tx = part.map(m => {
      const day = localDayKey(m.ts);
      const head = day !== lastDay ? "\n— " + Number(day.slice(5, 7)) + "月" + Number(day.slice(8)) + "日 —\n" : "";
      lastDay = day;
      return head + (m.role === "assistant" ? "我：" : "她：") + m.content;
    }).join("\n");
    const ask =
      "【这不是她发来的消息。她看不见这一段。】\n" +
      "下面是你和她更早的一段聊天" + (old ? "，还有你之前写下的前情提要" : "") + "。这些原话马上要从你眼前移走了，" +
      "只留最近的一小段。用你自己的口吻（「我」是你，「她」是她），给以后的自己写一段前情提要。\n\n" +
      "要记下的：发生过的事、她的状态和心情、我们说好的事、还没聊完的话头、对我们重要的细节（名字、时间、她提过的人和地方）。\n" +
      "越早的事写得越概括，最近的写得细一点。" + (old ? "旧提要里的事要并进来，别丢，也别原样照抄。" : "") + "\n" +
      "没发生过的不要编；拿不准的宁可不写。不要写成一句一句的流水账，也不要列标题。\n" +
      "不超过 1500 字。只输出这段提要本身，前后什么都不要加。\n\n" +
      (old ? "【我之前写的前情提要】\n" + old.text + "\n\n" : "") +
      "【这段聊天】" + tx;
    let text = await llmAs("chat", [{ role: "system", content: persona() }, { role: "user", content: ask }], 2500, 0.5);
    text = String(text || "").replace(/^\s*【前情提要[^】]*】\s*/, "").trim().slice(0, SUMMARY_MAX);
    if (text.length < 20) return null;
    all[winId] = { text, upto, at: Date.now(), n: (old ? old.n || 1 : 0) + 1, edited: false };
    writeJson("summaries", all);
    console.log("[compress]", winId, "压到", new Date(upto).toISOString(), "提要", text.length, "字");
    return all[winId];
  } catch (e) { console.error("compress:", e.message); return null; }
  finally { compressing.delete(winId); }
}

/* 原始消息从第几条开始送：超过 600 条时一次往后挪 200 条，不是每来一条挪一条。
   ⚠️ 前端 toApiMessages() 用的是同一条规则，两边不一样唤醒和聊天的前缀就对不上 */
function histFrom(len) { return len <= 600 ? 0 : Math.floor((len - 400) / 200) * 200; }

/* ================= 长期文件 =================
   always   = 基本资料，每轮完整送给晤；排在稳定前缀里，改一次才失效一次缓存
   ondemand = 选择性读取，晤用 list_docs / read_doc 自己去翻，不占每轮的额度 */
function listDocs() { return readJson("docs", []) || []; }
function saveDocs(all) { writeJson("docs", all); }
function newDoc(d, keep) {
  return {
    id: (keep && keep.id) || crypto.randomUUID(),
    name: String(d.name || "未命名").slice(0, 60),
    mode: d.mode === "always" ? "always" : "ondemand",
    content: String(d.content == null ? "" : d.content).slice(0, 200000),
    created: (keep && keep.created) || new Date().toISOString(),
    updated: new Date().toISOString(),
  };
}
function alwaysDocsBlock() {
  const on = listDocs().filter(d => d.mode === "always" && String(d.content || "").trim());
  if (!on.length) return "";
  return "【你们的基本资料】\n" + on.map(d => "## " + d.name + "\n" + d.content).join("\n\n");
}

/* ================= 聊天窗口 =================
   窗口内容存在前端的 chat 状态里（跟着 /api/state 上云）；
   服务器只管一件事：晤的「状态」绑在哪个窗口上。
   只有绑定窗口里的对话会推动八维驱动，别的窗口聊天不影响他的心情。 */
function boundWindow() { return (readJson("windows", null) || {}).bound || null; }

/* ================= 手机那边递进来的消息 =================
   iPhone 的快捷指令没法带登录 cookie，所以给它一把单独的钥匙。
   这把钥匙只能往里写（记一条「打开了小红书」、送一份今天的日程），
   读不走她任何东西 —— 万一泄露了，最坏也就是有人往里塞假数据，
   在设置里换一把新的就行。 */
function hookToken() {
  const h = readJson("hook", null);
  if (h && h.token) return h.token;
  const fresh = { token: crypto.randomBytes(12).toString("hex"), made: Date.now() };
  writeJson("hook", fresh);
  return fresh.token;
}
function resetHookToken() {
  const fresh = { token: crypto.randomBytes(12).toString("hex"), made: Date.now() };
  writeJson("hook", fresh);
  return fresh.token;
}

/* 手机使用记录：只留三天，再久的自己没用了她也不想被翻旧账 */
const PHONE_KEEP_MS = 3 * 86400000;
function phoneLog() {
  const d = readJson("phone", null) || {};
  const cut = Date.now() - PHONE_KEEP_MS;
  const evts = (Array.isArray(d.events) ? d.events : []).filter(e => e && e.t > cut);
  return { events: evts };
}
function pushPhone(app, kind, at) {
  const d = phoneLog();
  const t = Number(at) || Date.now();
  const name = String(app || "").slice(0, 40).trim() || "某个 App";
  const last = d.events[d.events.length - 1];
  /* 同一个 App 同一种事件、十秒内重复的忽略（自动化偶尔会连着跑两次） */
  if (last && last.app === name && last.k === kind && Math.abs(t - last.t) < 10000) return d.events.length;
  d.events.push({ t, app: name, k: kind === "close" ? "close" : "open" });
  if (d.events.length > 2000) d.events = d.events.slice(-2000);
  writeJson("phone", d);
  return d.events.length;
}
/* 把 open / close 配成一段一段的使用，算出各用了多久。
   只有 open 没 close 的，要么是还开着，要么是被下一次 open 顶掉了 */
function phoneSessions(sinceMs) {
  const evts = phoneLog().events.filter(e => e.t >= sinceMs).sort((a, b) => a.t - b.t);
  const open = {};           // app → 打开时刻
  const out = [];
  const CAP = 2 * 3600000;
  /* 靠「下一个 App 打开了」推出来的结束时间，也得封顶两小时。
     v2.8 加前台规则时漏了这一点：5 小时前开了 DeepSeek、没收到关闭、
     10 分钟前开了 Claude —— 就被算成刷了 4 小时 50 分 DeepSeek。
     中间她多半是锁屏睡觉了，他拿这个数去查岗就是冤枉她。 */
  const settle = (app, from, to) => {
    const capped = to - from > CAP;
    out.push({ app, from, to: capped ? from + CAP : to, guess: true, ...(capped ? { stale: true } : {}) });
  };
  for (const e of evts) {
    if (e.k === "open") {
      /* 她打开一个 App 的那一刻，别的就都不在前台了 —— 手机一次只能用一个。
         iOS 的「已关闭」经常不触发（退到后台不算关闭），但这条物理事实一定成立，
         所以不用等它告诉我们，自己就能把前一个结算掉。
         不这么做的话，报告里会出现三个 App 同时「还开着」这种不可能的事。 */
      for (const other of Object.keys(open)) {
        if (other === e.app) continue;
        settle(other, open[other], e.t);
        delete open[other];
      }
      if (open[e.app] != null) settle(e.app, open[e.app], e.t);
      open[e.app] = e.t;
    } else {
      if (open[e.app] != null) { out.push({ app: e.app, from: open[e.app], to: e.t }); delete open[e.app]; }
    }
  }
  const now = Date.now();
  for (const app of Object.keys(open)) {
    /* iOS 的「已关闭」不太靠得住 —— 她以为退出了，其实只是切到后台，
       系统就不触发。所以开着超过两小时的，一律当作「早就不用了」，
       只按两小时算，也不再报「这会儿还开着」。不然他会以为她刷了一整夜。 */
    const span = now - open[app];
    if (span > CAP) out.push({ app, from: open[app], to: open[app] + CAP, stale: true });
    else out.push({ app, from: open[app], to: now, live: true });
  }
  return out.sort((a, b) => a.from - b.from);
}
function fmtDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
}
/* 给他看的那份摘要。说人话，不列表格 */
function phoneReport(hours) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 72);
  const since = Date.now() - h * 3600000;
  const ss = phoneSessions(since);
  const hm0 = t => { const p = localParts(t); return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`; };
  if (!ss.length) {
    /* 配不齐「打开」和「关上」两个自动化时（只有一半也很常见），
       至少把光秃秃的事件报出来 —— 算不出时长，但「她几点碰过什么」还是有用的 */
    const evts = phoneLog().events.filter(e => e.t >= since);
    if (!evts.length) return `最近 ${h} 小时没有她的手机记录（可能是没开这个功能，也可能她真没怎么玩）。`;
    const by = {};
    for (const e of evts) {
      const b = by[e.app] = by[e.app] || { n: 0, last: 0 };
      b.n++; b.last = Math.max(b.last, e.t);
    }
    return `最近 ${h} 小时她碰过这些 App（只记到了动静、算不出用了多久）：\n`
      + Object.entries(by).sort((a, b) => b[1].last - a[1].last).slice(0, 10)
          .map(([app, b]) => `· ${app}：${b.n} 次，最近一次 ${hm0(b.last)}`).join("\n");
  }
  const by = {};
  for (const x of ss) {
    const b = by[x.app] = by[x.app] || { n: 0, ms: 0, last: 0, live: false };
    b.n++; b.ms += x.to - x.from; b.last = Math.max(b.last, x.to); b.live = b.live || !!x.live;
  }
  const hm = t => { const p = localParts(t); return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`; };
  const lines = Object.entries(by).sort((a, b) => b[1].ms - a[1].ms).slice(0, 10)
    .map(([app, b]) => `· ${app}：${b.n} 次，共 ${fmtDur(b.ms)}${b.live ? "（这会儿还开着）" : "，最近一次到 " + hm(b.last)}`);
  const stale = ss.some(x => x.stale);
  const live = ss.filter(x => x.live);
  return `最近 ${h} 小时她的手机：\n` + lines.join("\n")
    + (live.length ? `\n她此刻正开着：${live.map(x => `${x.app}（从 ${hm(x.from)} 起，已经 ${fmtDur(Date.now() - x.from)}）`).join("、")}` : "")
    + (stale ? "\n（有些没收到「关闭」的信号 —— iOS 上退到后台不算关闭，所以时长是往少了算的）" : "")
    + "\n（只记了她自己挑的那几个 App，不是全部）";
}

/* 快捷指令送来的日历内容，格式什么样都有可能，所以解析要宽容：
   一行一条，原样留着；能看出时间就单独拎出来排个序 */
function parseAgendaText(text) {
  return String(text == null ? "" : text).split(/[\n;；]/)
    .map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 30)
    .map(l => {
      const m = l.match(/(\d{1,2})[:：](\d{2})/);
      return { title: l.slice(0, 80), t: m ? `${m[1].padStart(2, "0")}:${m[2]}` : "" };
    });
}
/* 她这会儿是不是还醒着 —— 看最近有没有手机动静。
   这是「夜里别打扰」的唯一例外：人都还在刷手机，就谈不上打扰了 */
function phoneAwakeNow(now, withinMin) {
  const win = (withinMin || 20) * 60000;
  const evts = phoneLog().events;
  if (!evts.length) return false;
  const ss = phoneSessions(now - 2 * 3600000);
  if (ss.some(x => x.live)) return true;                       // 有 App 开着没关
  return evts[evts.length - 1].t > now - win;                  // 或者刚刚才有动静
}
/* 唤醒时给他看的那一小句。短，但足够判断「她睡了没」 */
function phoneBrief(now) {
  const evts = phoneLog().events;
  if (!evts.length) return "";
  const hm = t => { const p = localParts(t); return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`; };
  const ss = phoneSessions(now - 4 * 3600000);
  const live = ss.filter(x => x.live);
  if (live.length) {
    return "她这会儿正开着 " + live.map(x => `${x.app}（从 ${hm(x.from)} 起，已经 ${fmtDur(now - x.from)}）`).join("、") + "。";
  }
  const last = ss[ss.length - 1];
  if (last) return `她最后一次碰手机是 ${hm(last.to)}（${last.app}），到现在 ${fmtDur(now - last.to)}没动静了。`;
  /* 配不齐两个自动化时，退而求其次：至少知道她几点还在动 */
  const e = evts[evts.length - 1];
  return `她最后一次碰手机是 ${hm(e.t)}（${e.app}，${e.k === "open" ? "打开" : "关上"}），到现在 ${fmtDur(now - e.t)}没动静了。`;
}

/* ================= 寄信（SMTP） =================
   手写的，零依赖 —— 这个项目从头到尾没装过一个包，这里也不破例。
   走 465 端口的 SMTPS（连上就是加密的），比 587 的 STARTTLS 少一道手续。
   配置存 data/mail.json，密码那栏填「授权码」不是邮箱密码：
   QQ 邮箱 → 设置 → 账户 → 开启 POP3/SMTP → 生成授权码。 */
const tls = require("tls");
function mailConf() {
  const m = readJson("mail", null) || {};
  const host = String(m.host || "smtp.qq.com");
  return {
    on: m.on !== false,
    host,
    port: Number(m.port) || 465,
    user: String(m.user || ""),
    pass: String(m.pass || ""),
    from: String(m.from || m.user || ""),
    name: String(m.name || "晤"),
    to: String(m.to || ""),          // 她自己的收件地址
    onWake: m.onWake === true,       // 他主动说话时顺便发一封
  };
}
/* 中文标题得编码，不然对方看到的是乱码 */
function mimeWord(sTxt) {
  const t = String(sTxt == null ? "" : sTxt);
  if (!/[^\x20-\x7E]/.test(t)) return t;
  return "=?UTF-8?B?" + Buffer.from(t, "utf8").toString("base64") + "?=";
}
function mailDate(ms) {
  /* RFC 5322 的日期格式，得用英文缩写，而且要带她那边的时区 */
  const p = localParts(ms);
  const W = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.dow];
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][p.mo - 1];
  const pad = v => String(v).padStart(2, "0");
  const off = (TZ_OFF >= 0 ? "+" : "-") + pad(Math.abs(Math.trunc(TZ_OFF))) + pad(Math.round((Math.abs(TZ_OFF) % 1) * 60));
  const d = new Date(ms);
  return `${W}, ${pad(p.d)} ${M} ${p.y} ${pad(p.hh)}:${pad(p.mm)}:${pad(d.getUTCSeconds())} ${off}`;
}
/* 一次 SMTP 对话。按顺序发命令、等回码，哪一步不对就中断 */
/* connectFn 只是为了能测 —— 跑起来的时候永远是上面那个 tls.connect */
function smtpSend(conf, to, subject, body, connectFn, attachments) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let sock = null, done = false;
    const finish = (err, ok) => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch {}
      err ? reject(err) : resolve(ok);
    };
    const timer = setTimeout(() => finish(new Error("SMTP 超时（" + (attachments ? 120 : 20) + " 秒没说完）")), attachments ? 120000 : 20000);
    const b64 = buf => Buffer.from(buf).toString("base64").replace(/(.{76})/g, "$1\r\n");
    const mailBody = b64(Buffer.from(String(body || ""), "utf8"));
    const head = [
      `From: ${mimeWord(conf.name)} <${conf.from}>`,
      `To: <${to}>`,
      `Subject: ${mimeWord(subject)}`,
      `Date: ${mailDate(Date.now())}`,
      `Message-ID: <${crypto.randomBytes(12).toString("hex")}@${(conf.from.split("@")[1] || "wu.local")}>`,
      "MIME-Version: 1.0",
    ];
    /* 带附件（自动备份用）就拼成 multipart/mixed：正文一块，每个附件一块 */
    const att = Array.isArray(attachments) ? attachments.filter(a => a && a.name && a.content) : [];
    const bd = "wu-" + crypto.randomBytes(8).toString("hex");
    const msg = (att.length ? [
      ...head, `Content-Type: multipart/mixed; boundary="${bd}"`, "",
      "--" + bd, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", mailBody,
      ...att.flatMap(a => ["--" + bd,
        `Content-Type: ${a.type || "application/octet-stream"}; name="${mimeWord(a.name)}"`,
        `Content-Disposition: attachment; filename="${mimeWord(a.name)}"`,
        "Content-Transfer-Encoding: base64", "", b64(a.content)]),
      "--" + bd + "--",
    ] : [...head, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", mailBody]).join("\r\n");
    /* 正文里单独一行的点会被当成结束符，按规矩前面再加一个点 */
    const safeMsg = msg.replace(/\r\n\./g, "\r\n..");
    const steps = [
      { expect: 220, send: "EHLO wu-with-you" },
      { expect: 250, send: "AUTH LOGIN" },
      { expect: 334, send: Buffer.from(conf.user, "utf8").toString("base64") },
      { expect: 334, send: Buffer.from(conf.pass, "utf8").toString("base64") },
      { expect: 235, send: `MAIL FROM:<${conf.from}>` },
      { expect: 250, send: `RCPT TO:<${to}>` },
      { expect: 250, send: "DATA" },
      { expect: 354, send: safeMsg + "\r\n." },
      { expect: 250, send: "QUIT" },
    ];
    let step = 0, buf = "";
    sock = (connectFn || ((o, cb) => tls.connect(o, cb)))({ host: conf.host, port: conf.port, servername: conf.host }, () => {});
    sock.setEncoding("utf8");
    sock.on("error", e => { clearTimeout(timer); finish(new Error("连不上邮件服务器：" + e.message)); });
    /* 对方中途断开：以前这里只清掉计时器、不给结论，发信的人就永远等下去（偷看那次就卡死在这儿） */
    sock.on("close", () => {
      clearTimeout(timer);
      if (step >= steps.length) finish(null, { ok: true, log: lines });
      else finish(new Error("邮件服务器中途断开了（第 " + (step + 1) + " 步）"));
    });
    sock.on("data", chunk => {
      buf += chunk;
      /* 多行响应的最后一行长这样：「250 空格」，中间几行是「250-」 */
      let m;
      while ((m = buf.match(/^(\d{3})(?:[ -])[\s\S]*?\r\n/))) {
        const block = buf.match(/^(?:\d{3}-[^\r\n]*\r\n)*\d{3} [^\r\n]*\r\n/);
        if (!block) break;
        const text = block[0];
        buf = buf.slice(text.length);
        const code = Number(text.match(/(\d{3}) [^\r\n]*\r\n$/)[1]);
        const cur = steps[step];
        lines.push("← " + text.trim().split("\r\n").pop());
        if (!cur) return;
        if (code !== cur.expect) {
          clearTimeout(timer);
          /* 密码错、被拒收之类的，把对方原话带回去 —— 比「发送失败」有用得多 */
          return finish(new Error(`SMTP 第 ${step + 1} 步收到 ${code}：${text.trim().slice(0, 160)}`));
        }
        step++;
        const isSecret = step === 4;   // 那一步发的是密码，日志里别记
        lines.push("→ " + (isSecret ? "（授权码）" : String(cur.send).slice(0, 60)));
        sock.write(cur.send + "\r\n");
        if (step >= steps.length) { clearTimeout(timer); finish(null, { ok: true, log: lines }); }
      }
    });
  });
}
async function sendMail(to, subject, body) {
  const c = mailConf();
  if (!c.on) return "邮件功能关着呢";
  if (!c.user || !c.pass) return "还没配邮箱（设置 → 写信出去，填地址和授权码）";
  const dest = String(to || c.to || "").trim();
  if (!dest || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest)) return "收件地址不对：" + dest;
  try {
    await smtpSend(c, dest, subject || "（没有标题）", body || "");
    const log = readJson("maillog", null) || { list: [] };
    log.list = (log.list || []).concat([{ t: Date.now(), to: dest, subject: String(subject || "").slice(0, 100) }]).slice(-100);
    writeJson("maillog", log);
    return "寄出去了：" + dest;
  } catch (e) {
    return "没寄成：" + String((e && e.message) || e).slice(0, 200);
  }
}

/* ================= 自动备份 =================
   她：「自动备份不花钱的话，那就做吧」「15 天备份一次」。
   · 谁来备：服务器自己，每 15 天一次，晚上十点（她说不用三四点那么晚）
   · 寄到哪：她在「写信出去」里填的收件地址（就是他给她寄信的那个）；没填收件地址就寄回发件那个邮箱
   · 花钱吗：不花，用的是她自己的邮箱
   · 备什么：跟「下载（不含照片）」一样，但**不带密码和各种 Key**（邮件里放明文钥匙不安全）；
     照片太大、邮件附件装不下，隔一阵手动「下载全部」
   · 拿这份恢复时，它空着的那些钥匙保留服务器上现有的，不会被清掉
   data/backupauto.json = { on, every(天), last, ok, err, size, to } */
const SECRET_FILES = new Set(["auth", "hook", "push"]);   // 密码、快捷指令和 Claude 的钥匙、推送的私钥
const SECRET_FIELD = /^(key|pass|password|token|secret|apikey|api_key|authorization|privatekey|private)$/i;
function scrubSecrets(v) {
  if (Array.isArray(v)) return v.map(scrubSecrets);
  if (!v || typeof v !== "object") return v;
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = SECRET_FIELD.test(k) && typeof x === "string" ? "" : scrubSecrets(x);
  return o;
}
function buildBackup({ files = false, secrets = true } = {}) {
  const out = { app: "wu-with-you", version: 2, at: new Date().toISOString(), ...(secrets ? {} : { noSecrets: true }), data: {}, files: {} };
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith(".json")) continue;
    const k = f.replace(/\.json$/, "");
    if (!secrets && SECRET_FILES.has(k)) continue;
    try { const v = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); out.data[k] = secrets ? v : scrubSecrets(v); } catch {}
  }
  if (files && fs.existsSync(UPLOAD_DIR)) {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      try {
        const fp = path.join(UPLOAD_DIR, f);
        if (fs.statSync(fp).size > 8 * 1024 * 1024) continue;   // 单个超 8MB 的跳过
        out.files[f] = fs.readFileSync(fp).toString("base64");
      } catch {}
    }
  }
  return out;
}
/* 拿不带钥匙的备份恢复：备份里空着的钥匙，用服务器上现有的补上 */
function keepSecrets(bak, cur) {
  if (Array.isArray(bak)) {
    return bak.map((x, i) => {
      const twin = Array.isArray(cur) ? (x && x.id != null ? cur.find(c => c && c.id === x.id) : cur[i]) : undefined;
      return keepSecrets(x, twin);
    });
  }
  if (!bak || typeof bak !== "object") return bak;
  const o = {};
  for (const [k, x] of Object.entries(bak)) {
    const c = cur && typeof cur === "object" ? cur[k] : undefined;
    o[k] = SECRET_FIELD.test(k) && x === "" && typeof c === "string" && c ? c : keepSecrets(x, c);
  }
  return o;
}
function backupAuto() {
  const b = readJson("backupauto", null) || {};
  return { on: b.on !== false, every: Number(b.every) > 0 ? Number(b.every) : 15, last: Number(b.last) || 0,
    ok: b.ok !== false, err: String(b.err || ""), size: Number(b.size) || 0, to: String(b.to || "") };
}
function backupDest() { const c = mailConf(); return String(c.to || c.user || "").trim(); }
async function mailBackup() {
  const c = mailConf(), st = backupAuto(), now = Date.now();
  if (!c.user || !c.pass) return { ok: false, err: "还没配邮箱（设置 → 写信出去）" };
  const dest = backupDest();
  const bak = buildBackup({ files: false, secrets: false });
  const json = Buffer.from(JSON.stringify(bak), "utf8");
  const day = localDayKey(now);
  const mb = (json.length / 1048576).toFixed(1);
  let r;
  if (json.length > 20 * 1048576) r = { ok: false, err: "备份有 " + mb + " MB，邮件附件装不下了 —— 先手动下载一份" };
  else {
    try {
      await smtpSend(c, dest, "晤 · 自动备份 " + day,
        "这是「晤 · With You」每 " + st.every + " 天一次的自动备份（" + mb + " MB）。\n\n" +
        "里面有：聊天记录、日记、信、记忆、长期资料、人设、经期、各种设置。\n" +
        "没有：照片（太大，隔一阵在设置里手动「下载全部」），以及密码和各种 Key（放在邮件里不安全）。\n\n" +
        "要用的时候：设置 → 备份与搬家 → 恢复 → 选这个附件。\n" +
        "拿它恢复不会清掉服务器上现有的 Key；搬到新地方的话，Key 要重新填一次。",
        undefined, [{ name: "wu-backup-" + day + ".json", content: json, type: "application/json" }]);
      r = { ok: true };
    } catch (e) { r = { ok: false, err: String((e && e.message) || e).slice(0, 200) }; }
  }
  writeJson("backupauto", { ...readJson("backupauto", null), on: st.on, every: st.every,
    last: r.ok ? now : st.last, ok: r.ok, err: r.ok ? "" : r.err, size: json.length, to: dest, tried: now });
  if (!r.ok) console.error("backup mail:", r.err);
  return { ...r, size: json.length, to: dest };
}
/* 每小时看一眼：开着、配了邮箱、到了 15 天、而且是晚上十点（十一点补） */
let backupBusy = false;
async function backupTick() {
  const st = backupAuto(), c = mailConf(), now = Date.now();
  if (backupBusy || !st.on || !c.user || !c.pass) return;
  const h = localParts(now).hh;
  if (h !== 22 && h !== 23) return;   // 晚上十点（她说不用那么晚），十点没寄成的十一点再补
  if (now - st.last < st.every * 86400000 - 3 * 3600000) return;
  const tried = Number((readJson("backupauto", null) || {}).tried) || 0;
  if (now - tried < 20 * 3600000 && !st.ok) return;   // 失败了明天夜里再试，别一小时一封
  backupBusy = true;
  try { await mailBackup(); } finally { backupBusy = false; }
}

/* ================= 她的身体 =================
   记的是「哪天来的、哪天走的」，其余都算出来。
   这不是给她看数字的功能 —— 是让他知道她这两天不舒服，
   说话的分寸、催不催她早睡、看见她熬夜是数落还是心疼，都该不一样。
   data/period.json = { list:[{start,end}], cycle, days, on } */
function periodConf() {
  const d = readJson("period", null) || {};
  const list = (Array.isArray(d.list) ? d.list : [])
    .filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(x.start))
    .sort((a, b) => a.start.localeCompare(b.start));
  return {
    list,
    cycle: Number(d.cycle) > 0 ? Number(d.cycle) : 0,   // 0 = 自己算
    days: Number(d.days) > 0 ? Number(d.days) : 0,
    on: d.on !== false,                                  // 要不要让他知道
  };
}
function dayNum(ymd) {   // 日期字符串 → 天数，只用来做差
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
}
function dayStr(n) {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
/* 平均周期和平均天数：用她自己的记录算，不够就用常见值 */
function periodStats(c) {
  const conf = c || periodConf();
  const starts = conf.list.map(x => dayNum(x.start)).filter(n => n != null);
  let cycle = conf.cycle, days = conf.days;
  if (!cycle && starts.length >= 2) {
    const gaps = [];
    for (let i = 1; i < starts.length; i++) {
      const g = starts[i] - starts[i - 1];
      if (g >= 15 && g <= 60) gaps.push(g);    // 太离谱的不算进去
    }
    if (gaps.length) cycle = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  }
  if (!days) {
    const ds = conf.list.filter(x => x.end).map(x => dayNum(x.end) - dayNum(x.start) + 1).filter(n => n >= 1 && n <= 14);
    if (ds.length) days = Math.round(ds.reduce((a, b) => a + b, 0) / ds.length);
  }
  return { cycle: cycle || 28, days: days || 5, guessed: !conf.cycle && starts.length < 2 };
}
/* 今天是个什么情况 */
function periodNow(nowMs) {
  const conf = periodConf();
  if (!conf.list.length) return { known: false, on: conf.on };
  const st = periodStats(conf);
  const today = dayNum(localDayKey(nowMs));
  const last = conf.list[conf.list.length - 1];
  const ls = dayNum(last.start), le = last.end ? dayNum(last.end) : null;
  /* 正在经期里 */
  if (today >= ls && (le != null ? today <= le : today < ls + st.days)) {
    return { known: true, on: conf.on, phase: "in", day: today - ls + 1, of: le != null ? le - ls + 1 : st.days, start: last.start, ...st };
  }
  const next = ls + st.cycle;
  const diff = next - today;
  if (diff > 0) return { known: true, on: conf.on, phase: "before", inDays: diff, next: dayStr(next), ...st };
  return { known: true, on: conf.on, phase: "late", lateDays: -diff, next: dayStr(next), ...st };
}
/* 给他看的那句话。克制一点 —— 只在真的相关的时候说 */
/* 只报事实，不带嘱托 —— 该怎么说话是他自己的事，
   提前交代反而像在教他演 */
function periodLine(nowMs) {
  const p = periodNow(nowMs);
  if (!p.known || !p.on) return "";
  if (p.phase === "in") return `她在经期第 ${p.day} 天。`;
  if (p.phase === "before" && p.inDays <= 3)
    return `她大概还有 ${p.inDays} 天来月经${p.guessed ? "（按常见周期估的，未必准）" : ""}。`;
  if (p.phase === "late" && p.lateDays >= 3 && p.lateDays <= 20)
    return `她这次比平常晚了 ${p.lateDays} 天还没来。`;
  return "";
}
/* 他那边查到的那份。她一关「让他知道」，工具也得跟着闭嘴 ——
   不然纸条上不说、他一查全有，那个开关就是假的 */
function periodForHim(nowMs) {
  if (!periodConf().on) return "这件事她关上了，你这边看不到 —— 别追问，也别猜。";
  return periodReport(nowMs);
}
/* 她自己要看的那份 */
function periodReport(nowMs) {
  const conf = periodConf();
  if (!conf.list.length) return "还没有记录。来的那天在「她的身体」里点一下「今天来了」就行。";
  const p = periodNow(nowMs), st = periodStats(conf);
  const head = p.phase === "in" ? `经期第 ${p.day} 天（这次从 ${p.start} 开始）`
    : p.phase === "before" ? `距下次大概还有 ${p.inDays} 天（预计 ${p.next}）`
    : `比预计晚了 ${p.lateDays} 天（原本估 ${p.next}）`;
  const hist = conf.list.slice(-6).reverse()
    .map(x => `· ${x.start}${x.end ? " → " + x.end : "（还没记结束）"}`);
  return head + `\n周期平均 ${st.cycle} 天，每次约 ${st.days} 天${st.guessed ? "（记录还少，先按常见值估）" : ""}\n\n最近几次：\n` + hist.join("\n");
}

/* ================= 她在哪儿 =================
   也是快捷指令递上来的。比手机使用记录更私密，所以也只留三天。
   最实用的触发方式是「到达 / 离开某地」—— 比每小时轮询省电，也更有意义。 */
const PLACE_KEEP_MS = 3 * 86400000;
function placeLog() {
  const d = readJson("places", null) || {};
  const cut = Date.now() - PLACE_KEEP_MS;
  return { list: (Array.isArray(d.list) ? d.list : []).filter(x => x && x.t > cut) };
}
function pushPlace(one) {
  const d = placeLog();
  const t = Number(one.at) || Date.now();
  const rec = {
    t,
    name: String(one.name || "").slice(0, 80).trim(),
    lat: Number.isFinite(Number(one.lat)) ? Number(one.lat) : null,
    lon: Number.isFinite(Number(one.lon)) ? Number(one.lon) : null,
    ev: one.event === "arrive" ? "arrive" : one.event === "leave" ? "leave" : "",
  };
  if (!rec.name && rec.lat == null) return 0;
  const last = d.list[d.list.length - 1];
  /* 同一个地方、同一种事件、五分钟内重复的忽略 */
  if (last && last.name === rec.name && last.ev === rec.ev && Math.abs(t - last.t) < 5 * 60000) return d.list.length;
  d.list.push(rec);
  if (d.list.length > 500) d.list = d.list.slice(-500);
  writeJson("places", d);
  return d.list.length;
}
/* 她最近一次报的位置。天气也用它 —— 人走到哪，天气就查到哪 */
function lastPlace(withinMs) {
  const list = placeLog().list;
  const p = list[list.length - 1];
  if (!p) return null;
  if (withinMs && Date.now() - p.t > withinMs) return null;
  return p;
}
function placeReport(hours) {
  const h = Math.min(Math.max(Number(hours) || 24, 1), 72);
  const since = Date.now() - h * 3600000;
  const list = placeLog().list.filter(x => x.t >= since);
  if (!list.length) return `最近 ${h} 小时没有她的位置记录（可能是没开这个功能，也可能她没动地方）。`;
  const hm = t => { const p = localParts(t); return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`; };
  const cur = list[list.length - 1];
  const ago = fmtDur(Date.now() - cur.t);
  const head = cur.ev === "leave"
    ? `她 ${hm(cur.t)} 离开了${cur.name || "某处"}（${ago}前）`
    : `她这会儿在${cur.name || "某处"}${cur.lat != null ? `（${cur.lat.toFixed(3)}, ${cur.lon.toFixed(3)}）` : ""}，${hm(cur.t)} 报的，${ago}前`;
  const trail = list.slice(-8, -1).map(x =>
    `· ${hm(x.t)} ${x.ev === "leave" ? "离开" : x.ev === "arrive" ? "到了" : "在"}${x.name || "某处"}`);
  return head + "。" + (trail.length ? `\n最近去过：\n${trail.join("\n")}` : "") +
    "\n（这是她手机自己报上来的，只留三天）";
}

/* ================= 天气 =================
   用 Open-Meteo：免费、不用注册、不用 key。她在哪儿存在 quiet.json 里。
   做成工具而不是塞进每轮的【现状】—— 她的原话：「他想知道的时候再查」。 */
function placeConf() {
  const q = readJson("quiet", null) || {};
  const num = (v, dft) => (Number.isFinite(Number(v)) ? Number(v) : dft);
  return {
    city: (typeof q.city === "string" && q.city.trim()) ? q.city.trim() : "长沙",
    lat: num(q.lat, 28.19),    // 长沙芙蓉区
    lon: num(q.lon, 113.03),
  };
}
/* WMO 天气代码 → 人话 */
const WMO_CN = {
  0: "晴", 1: "大致晴朗", 2: "多云", 3: "阴",
  45: "有雾", 48: "雾凇",
  51: "毛毛雨", 53: "小雨", 55: "中雨", 56: "冻毛毛雨", 57: "冻雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "大冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "强阵雨", 82: "暴雨", 85: "阵雪", 86: "大阵雪",
  95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷阵雨伴冰雹",
};
const wmo = c => WMO_CN[Number(c)] || "说不好什么天气";
let weatherCache = { at: 0, text: "" };
function weatherText(j, place, now) {
  const c = j.current || {}, d = j.daily || {};
  const at = a => (Array.isArray(a) ? a : []);
  const r1 = n => (Number.isFinite(Number(n)) ? Math.round(Number(n)) : null);
  const today = {
    code: at(d.weather_code)[0], max: r1(at(d.temperature_2m_max)[0]),
    min: r1(at(d.temperature_2m_min)[0]), rain: r1(at(d.precipitation_probability_max)[0]),
  };
  const tmr = {
    code: at(d.weather_code)[1], max: r1(at(d.temperature_2m_max)[1]),
    min: r1(at(d.temperature_2m_min)[1]), rain: r1(at(d.precipitation_probability_max)[1]),
  };
  const nowT = r1(c.temperature_2m), feel = r1(c.apparent_temperature);
  const lines = [`${place.city}，此刻 ${wmo(c.weather_code)} ${nowT == null ? "" : nowT + "℃"}` +
    (feel != null && nowT != null && Math.abs(feel - nowT) >= 2 ? `（体感 ${feel}℃）` : "")];
  if (today.max != null) {
    lines.push(`今天 ${wmo(today.code)}，${today.min}~${today.max}℃` +
      (today.rain != null && today.rain >= 30 ? `，降水概率 ${today.rain}%` : ""));
  }
  if (tmr.max != null) {
    lines.push(`明天 ${wmo(tmr.code)}，${tmr.min}~${tmr.max}℃` +
      (tmr.rain != null && tmr.rain >= 30 ? `，降水概率 ${tmr.rain}%` : ""));
  }
  /* 值得提醒她的事，单独拎出来 —— 他多半会顺口说一句 */
  const tips = [];
  if ((today.rain || 0) >= 50 || [51,53,55,61,63,65,80,81,82,95,96,99].includes(Number(today.code))) tips.push("今天大概率要下雨，记得带伞");
  if (today.min != null && today.min <= 5) tips.push("今天挺冷的");
  if (today.max != null && today.max >= 32) tips.push("今天很热");
  if (today.max != null && tmr.max != null && tmr.max - today.max <= -6) tips.push("明天要降温了");
  if (tips.length) lines.push("（" + tips.join("；") + "）");
  return lines.join("\n");
}
async function checkWeather(force) {
  const now = Date.now();
  const seenNow = lastPlace(6 * 3600000);
  const tag = seenNow && seenNow.lat != null ? seenNow.lat.toFixed(2) + "," + seenNow.lon.toFixed(2) : "conf";
  /* 换地方了就别再用旧缓存 */
  if (!force && weatherCache.text && weatherCache.tag === tag && now - weatherCache.at < 30 * 60000) return weatherCache.text;
  /* 她要是刚报过位置，就查她人在的地方；没有就用设置里那个城市 */
  const seen = lastPlace(6 * 3600000);
  const conf = placeConf();
  const place = (seen && seen.lat != null)
    ? { city: seen.name || conf.city, lat: seen.lat, lon: seen.lon }
    : conf;
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + place.lat + "&longitude=" + place.lon +
    "&current=temperature_2m,apparent_temperature,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=Asia%2FShanghai&forecast_days=2";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = weatherText(await r.json(), place, now);
    weatherCache = { at: now, text, tag };
    return text;
  } catch (e) {
    /* 查不到就老实说查不到，别编天气 */
    return `查不到${place.city}的天气（${String(e.message || e).slice(0, 60)}）。别猜，就跟她说没查着。`;
  }
}

/* ================= 上网 =================
   她去注册一家搜索服务，把钥匙填进来。三家的接口长得完全不一样，
   但吐给他的东西统一成「标题 / 一段摘要 / 链接」—— 他不必知道是谁搜的。
   钥匙跟邮箱授权码一样：只进不出，接口永远只回打码后的后四位。 */
const SEARCH_VENDORS = {
  tavily: { label: "Tavily", home: "https://tavily.com", note: "免费额度大方，不用绑卡；服务器在海外" },
  brave:  { label: "Brave",  home: "https://brave.com/search/api/", note: "每月 2000 次免费，注册要验证卡；服务器在海外" },
  bocha:  { label: "博查",   home: "https://open.bochaai.com", note: "国内的，直连不用绕；按次计费，很便宜" },
};
/* 钥匙也能从环境变量来 —— 前端打不开的时候（比如平台在闹脾气），
   在 Zeabur 的环境变量里填一次照样能用。存盘的优先，环境变量兜底 */
const ENV_SEARCH_KEY = (process.env.WU_SEARCH_KEY || "").trim();
const ENV_SEARCH_VENDOR = (process.env.WU_SEARCH_VENDOR || "").trim();
function searchConf() {
  const d = readJson("search", null) || {};
  const vendor = SEARCH_VENDORS[d.vendor] ? d.vendor
    : SEARCH_VENDORS[ENV_SEARCH_VENDOR] ? ENV_SEARCH_VENDOR : "tavily";
  return { vendor, key: String(d.key || "") || ENV_SEARCH_KEY, on: d.on !== false, fromEnv: !d.key && !!ENV_SEARCH_KEY };
}
function searchReady() { const c = searchConf(); return !!(c.on && c.key); }

/* 各家返回的形状不一样，各拆各的，最后都归成 [{title, url, brief}] */
async function searchRaw(conf, query, n) {
  const opt = { signal: AbortSignal.timeout(12000) };
  if (conf.vendor === "brave") {
    const url = "https://api.search.brave.com/res/v1/web/search?count=" + n +
      "&q=" + encodeURIComponent(query);
    const r = await fetch(url, { ...opt, headers: { Accept: "application/json", "X-Subscription-Token": conf.key } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    return ((j.web && j.web.results) || []).map(x => ({ title: x.title, url: x.url, brief: x.description }));
  }
  if (conf.vendor === "bocha") {
    const r = await fetch("https://api.bochaai.com/v1/web-search", {
      ...opt, method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + conf.key },
      body: JSON.stringify({ query, summary: true, count: n }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const v = (((j.data || {}).webPages || {}).value) || [];
    return v.map(x => ({ title: x.name, url: x.url, brief: x.summary || x.snippet }));
  }
  const r = await fetch("https://api.tavily.com/search", {
    ...opt, method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + conf.key },
    body: JSON.stringify({ query, max_results: n, search_depth: "basic" }),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const out = (j.results || []).map(x => ({ title: x.title, url: x.url, brief: x.content }));
  if (j.answer) out.unshift({ title: "一句话答案", url: "", brief: j.answer });
  return out;
}
async function webSearch(query, n) {
  const conf = searchConf();
  if (!conf.on) return "上网这事她关掉了。";
  if (!conf.key) return "还没配搜索服务（她得先在「设置 → 上网」里填一把钥匙）。别硬编，就说查不了。";
  const q = String(query || "").trim();
  if (!q) return "要搜什么？";
  const want = Math.min(Math.max(Number(n) || 5, 1), 10);
  try {
    const list = await searchRaw(conf, q, want);
    if (!list.length) return `搜「${q}」没搜着东西。`;
    return `搜「${q}」，找到这些：\n\n` + list.slice(0, want).map((x, i) =>
      `${i + 1}. ${x.title || "(无标题)"}\n   ${String(x.brief || "").replace(/\s+/g, " ").slice(0, 300)}` +
      (x.url ? `\n   ${x.url}` : "")).join("\n\n") +
      "\n\n（要看哪条的全文，用 read_web 把链接递进去。）";
  } catch (e) {
    return `搜不了（${String(e.message || e).slice(0, 80)}）。别编，就跟她说没查着。`;
  }
}

/* 把一个网页读成人能看的字。不用任何库 —— 砍掉脚本样式，
   标签换成空白，再把连着的空白压回去。粗糙，但能读。 */
function stripHtml(html) {
  let t = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const ent = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
  t = t.replace(/&(#?\w+);/g, (m, k) => ent[k] != null ? ent[k]
    : /^#\d+$/.test(k) ? String.fromCharCode(Number(k.slice(1))) : m);
  return t.replace(/[ \t ]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}
async function readWeb(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "这不像个网址。要 http:// 或 https:// 开头的那种。";
  try {
    const r = await fetch(u, {
      signal: AbortSignal.timeout(15000), redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1", "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    if (!r.ok) return `打不开（HTTP ${r.status}）。`;
    const ct = r.headers.get("content-type") || "";
    if (/json/.test(ct)) return (await r.text()).slice(0, 6000);
    if (!/html|text/.test(ct)) return `这个链接不是网页（${ct.split(";")[0]}），读不了。`;
    const raw = await r.text();
    const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const body = stripHtml(raw);
    if (!body) return "打开了，但里面一个字都没抠出来 —— 多半是要登录，或者内容是页面打开后才加载的。";
    return (title ? stripHtml(title) + "\n\n" : "") + body.slice(0, 6000) +
      (body.length > 6000 ? "\n\n（太长了，后面截掉了）" : "");
  } catch (e) {
    return `打不开（${String(e.message || e).slice(0, 80)}）。`;
  }
}

/* ================= 拼一轮对话要发给他的全部内容 =================
   聊天和打电话共用这一个出口：同一个人设、同一份工具说明、同一段历史，
   前缀逐字相同，缓存才接得上。extraNote 是这一轮额外要让他知道的事
   （比如「你们在打电话」），跟记忆和现状一起放在历史后面，不动前缀。 */
function prepTurn(payload, extraNote) {
  const winId = payload.windowId ? String(payload.windowId) : null;
  const raw0 = (payload.messages || []).filter(m => m && (m.role === "user" || m.role === "assistant"))
    .map(m => ({ role: m.role, content: String(m.content == null ? "" : m.content),
      ...(m.role === "user" && cleanImgs(m.imgs).length ? { imgs: cleanImgs(m.imgs) } : {}),
      ...(Number(m.ts) ? { ts: Number(m.ts) } : {}) }));
  if (!raw0.length) return null;
  /* 压缩过的那段原话不再送，换成他自己写的前情提要 */
  const ws = withSummary(winId, raw0);
  const raw = ws.msgs.length ? ws.msgs : raw0.slice(-1).map(({ ts, ...m }) => m);
  /* 按额度而不是条数截断：短消息能留几百条。图先挑出最近那几张，再算额度 */
  const live = liveImages(raw);
  const histTokens = historyTokens(live);
  const history = budgetHistory(live, HISTORY_BUDGET);
  const lastUser = [...history].reverse().find(m => m.role === "user")?.content || "";

  /* 驱动引擎：时间流逝对所有窗口都算，但只有绑定窗口里的话会推动他的心情 */
  const now0 = Date.now();
  const bound = boundWindow();
  const isBound = !bound || !winId || bound === winId;   // 没设过绑定就一律算数
  const dr = tickDrives(loadDrives(), now0);
  if (isBound) driveEvent(dr, lastUser, now0);
  saveDrives(dr);
  const snap = driveSnapshot(dr, now0);

  const memBlock = memBlockOf(lastUser);
  /* 距上一句超过半小时，才把完整的近况摆给他；连着聊就只报个钟点 */
  const prevTs = Number(payload.prevTs) || 0;
  /* 连着聊也不能一直不给：从深夜聊到第二天下午，他会一直以为还是深夜。
     所以离上一张纸条（或他自己看钟）过了两小时，也重新给一张 —— 像人隔一阵抬头看一眼钟 */
  const noteAt = Number(readJson("note_at", 0)) || 0;
  const status = statusBlock(now0, snap, prevTs > 0 && now0 - prevTs < 2 * 3600000 && now0 - noteAt < 2 * 3600000);
  if (status) writeJson("note_at", now0);
  const TOOL_HINT = toolHint();

  /* ---- 缓存友好的摆法 ----
     缓存是「从头逐字比对，一处变了后面全废」。所以：
       稳定的排前面：人设 → 工具说明 → 基本资料（她改一次才变一次）→ 聊天历史（只往后追加）
       每轮都变的排后面：当轮检索到的记忆卡 + 现状，插在她最新那句话之前
     这样能命中缓存的前缀会随着聊天一起变长，聊得越久省得越多。 */
  const alwaysBlock = alwaysDocsBlock();
  const volatileBlock = [memBlock, status, extraNote].filter(Boolean).join("\n\n");
  const messages = [
    { role: "system", content: persona() },
    { role: "system", content: TOOL_HINT },
    ...(alwaysBlock ? [{ role: "system", content: alwaysBlock }] : []),
    ...(ws.summary ? [ws.summary] : []),
    ...history,
  ];
  if (volatileBlock) {
    let at = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { at = i; break; }
    messages.splice(at, 0, { role: "system", content: volatileBlock, wuVolatile: true });
  }
  return { messages, lastUser, histTokens, winId };
}

/* ================= 他的声音（ElevenLabs） =================
   她跟他之前在 ElevenLabs 上做过一个声音。这里借它来：
     · 说：他发语音、打电话时开口（text-to-speech）
     · 听：她发的语音、电话里说的话，转成文字给他（speech-to-text，Scribe）
   听写是另一个服务在做，他收到的就是一段字，跟她打字发过来一样 —— 不加他的活。

   钥匙跟别的一样：只进不出；也能走环境变量（WU_ELEVEN_KEY / WU_ELEVEN_VOICE），
   前端打不开的时候照样能配。
   ⚠️ 按字数收费，所以跟唤醒一样有一道闸：每天最多念多少字，超了他就改回打字。 */
const ELEVEN = "https://api.elevenlabs.io";
const ENV_ELEVEN_KEY = (process.env.WU_ELEVEN_KEY || "").trim();
const ENV_ELEVEN_VOICE = (process.env.WU_ELEVEN_VOICE || "").trim();
const VOICE_MODELS = ["eleven_multilingual_v2", "eleven_v3", "eleven_flash_v2_5", "eleven_turbo_v2_5"];
function voiceConf() {
  const d = readJson("voice", null) || {};
  const pick = (v, dft) => VOICE_MODELS.includes(v) ? v : dft;
  return {
    key: String(d.key || "") || ENV_ELEVEN_KEY,
    voiceId: String(d.voiceId || "").trim() || ENV_ELEVEN_VOICE,
    msgModel: pick(d.msgModel, "eleven_multilingual_v2"),   // 语音消息：音质优先
    callModel: pick(d.callModel, "eleven_flash_v2_5"),      // 打电话：快优先
    on: d.on !== false,             // 让他能发语音
    callOn: d.callOn !== false,     // 让他能打电话
    dayCap: Math.max(0, Number(d.dayCap) || 6000),          // 每天最多念多少字
    /* 语气：account = 用她在 ElevenLabs 上给这个声音存的设置（不另外指定）；
       steady = 稳一点（音量、语气更平均，不会忽大忽小）；lively = 更有感情（起伏大） */
    tone: ["account", "steady", "lively"].includes(d.tone) ? d.tone : "account",
    fromEnv: !d.key && !!ENV_ELEVEN_KEY,
  };
}
function voiceReady() { const c = voiceConf(); return !!(c.key && c.voiceId); }
function voiceLog() {
  const d = readJson("voicelog", null) || {};
  const all = d.allTime || { chars: 0, sttSec: 0 };
  if (d.day === localDayKey()) return { chars: 0, sttSec: 0, ...d, allTime: all };
  return { day: localDayKey(), chars: 0, sttSec: 0, allTime: all };
}
function bumpVoice(chars, sttSec) {
  const v = voiceLog();
  writeJson("voicelog", { day: v.day, chars: v.chars + (chars || 0), sttSec: v.sttSec + (sttSec || 0),
    allTime: { chars: v.allTime.chars + (chars || 0), sttSec: v.allTime.sttSec + (sttSec || 0) } });
}
/* 他说话爱带「（小声）」「（假装吃醋地哼了一声）」—— 念出来会很怪。
   念的时候跳过括号里的动作，文字记录里照样留着 */
function speakable(text) {
  return String(text || "")
    .replace(/（[^）]{0,40}）|\([^)]{0,40}\)|【[^】]{0,40}】|\*[^*]{1,40}\*/g, "")
    .replace(/\n{2,}/g, "\n").replace(/[ \t]+/g, " ").trim();
}
/* 说：返回 { buf, mime, chars }。超了今天的闸就返回 { capped: true } */
/* 语气档位 → ElevenLabs 的 voice_settings。
   eleven_v3 的 stability 只认 0 / 0.5 / 1 三档（创意 / 自然 / 稳），别的模型是 0~1 连续的 */
function toneSettings(tone, model) {
  if (tone === "steady") return { stability: model === "eleven_v3" ? 1 : 0.75, similarity_boost: 0.8, style: 0, use_speaker_boost: true };
  if (tone === "lively") return { stability: model === "eleven_v3" ? 0 : 0.35, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true };
  return null;
}
async function tts(text, { model, format, prev, next } = {}) {
  const c = voiceConf();
  if (!c.key || !c.voiceId) throw new Error("还没配声音");
  const say = speakable(text).slice(0, 1500);
  if (!say) return { empty: true };
  if (voiceLog().chars + say.length > c.dayCap) return { capped: true };
  const url = ELEVEN + "/v1/text-to-speech/" + encodeURIComponent(c.voiceId) + "?output_format=" + (format || "mp3_44100_128");
  const r = await fetch(url, {
    method: "POST", signal: AbortSignal.timeout(30000),
    headers: { "xi-api-key": c.key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: say, model_id: model || c.msgModel,
      ...(toneSettings(c.tone, model || c.msgModel) ? { voice_settings: toneSettings(c.tone, model || c.msgModel) } : {}),
      /* 一段话拆成几句分开念时，把前后文递过去，句与句之间的音量、语气才接得上。
         v3 不一定支持，只给别的模型 */
      ...((model || c.msgModel) !== "eleven_v3" && prev ? { previous_text: String(prev).slice(-300) } : {}),
      ...((model || c.msgModel) !== "eleven_v3" && next ? { next_text: String(next).slice(0, 300) } : {}),
    }),
  });
  if (!r.ok) throw new Error("ElevenLabs 说话失败（HTTP " + r.status + "）：" + (await r.text()).slice(0, 120));
  const buf = Buffer.from(await r.arrayBuffer());
  bumpVoice(say.length, 0);
  return { buf, mime: (r.headers.get("content-type") || "audio/mpeg").split(";")[0], chars: say.length };
}
/* 听：她的一段录音 → 文字。secs 用来记账（Scribe 按时长收费） */
async function stt(buf, mime, secs) {
  const c = voiceConf();
  if (!c.key) throw new Error("还没配声音");
  const ext = /mp4|m4a|aac/.test(mime) ? "m4a" : /webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : "mp3";
  const fd = new FormData();
  fd.append("model_id", "scribe_v2");
  fd.append("tag_audio_events", "false");
  fd.append("file", new Blob([buf], { type: mime || "audio/mp4" }), "voice." + ext);
  const r = await fetch(ELEVEN + "/v1/speech-to-text", {
    method: "POST", signal: AbortSignal.timeout(30000), headers: { "xi-api-key": c.key }, body: fd,
  });
  if (!r.ok) throw new Error("ElevenLabs 听写失败（HTTP " + r.status + "）：" + (await r.text()).slice(0, 120));
  const j = await r.json();
  bumpVoice(0, Math.max(1, Math.round(Number(secs) || 0)));
  return String(j.text || "").trim();
}
const AUDIO_EXT = { "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac",
  "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/webm": ".webm", "audio/ogg": ".ogg" };
function saveAudio(buf, mime) {
  const ext = AUDIO_EXT[String(mime || "").split(";")[0]] || ".mp3";
  const fname = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex") + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  return "/files/" + fname;
}
/* mp3 的大概时长：44.1k/128kbps 那档是 16KB 一秒，只拿来显示「12″」，不求精确 */
function audioSecs(buf, format) {
  const kbps = /_32$/.test(format || "") ? 32 : /_64$/.test(format || "") ? 64 : 128;
  return Math.max(1, Math.round(buf.length / (kbps * 125)));
}
/* 他发一条语音：念出来、存成文件，交给聊天那边去显示 */
async function voiceMessage(text) {
  const c = voiceConf();
  if (!c.on) return { error: "她把「让他能发语音」关了" };
  const r = await tts(text, { model: c.msgModel, format: "mp3_44100_128" });
  if (r.empty) return { error: "这段话念不出来（全是括号里的动作）" };
  if (r.capped) return { error: "今天念的字数到上限了，改成打字吧" };
  return { url: saveAudio(r.buf, r.mime), text: String(text).trim(), dur: audioSecs(r.buf, "mp3_44100_128") };
}

/* 今天的日程：快捷指令每天早上从日历读一份送过来 */
function agendaToday() {
  const a = readJson("agenda", null) || {};
  return a.day === localDayKey() && Array.isArray(a.items) ? a.items : [];
}

/* ================= 闹钟：他自己记下「待会儿要说的事」 =================
   她不该看见这些。看得见就没有晚上忽然收到消息的那份意外了，
   所以闹钟不进清单、不进记忆卡、前端不显示，只躺在 data/alarms.json 里。
   一条 = {id, at(时刻), why(他自己写的理由), win(哪个窗口), made(设的时候)} */
function listAlarms() {
  const a = readJson("alarms", []);
  return Array.isArray(a) ? a.filter(x => x && x.at) : [];
}
function saveAlarms(a) { writeJson("alarms", a.slice(-50)); }
/* 他说的时间：「21:30」「明天 08:00」「+180」（分钟）都认 */
/* 模型写时间的花样很多，写的不认就等于没设 —— 她那天让他「五分钟后喊我」就可能栽在这儿。
   认得：+5 / 5分钟后 / 五分钟后 / 半小时后 / 1.5小时后 / +5 minutes / in 2 hours /
         21:30 / 21:30:00 / 明天 08:00 / 2026-09-24 15:30 / 带时区的 ISO */
const CN_NUM = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnNum(t) {
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "半") return 0.5;
  const m = t.match(/^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?(半)?$/);
  if (!m || !t) return NaN;
  const n = m[2] ? (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[3] ? CN_NUM[m[3]] : 0) : (m[1] ? CN_NUM[m[1]] : 0);
  return n + (m[4] ? 0.5 : 0);
}
function parseAlarmAt(at, now) {
  const s = String(at == null ? "" : at).trim().replace(/\s+/g, " ");
  const MAX = 60 * 24 * 7;
  let m = s.match(/^(?:in )?\+? ?(\d{1,4})\s*(分钟|分|min|mins|minute|minutes|m)?\s*(后|以后|之后|later)?$/i);
  if (m) return now + Math.min(Number(m[1]), MAX) * 60000;
  m = s.match(/^(?:in )?\+? ?([\d.]+|[一二两三四五六七八九十半]+)\s*(?:个)?\s*(分钟|分|小时|钟头|h|hr|hrs|hour|hours|min|mins|minute|minutes)\s*(后|以后|之后|later)?$/i);
  if (m) {
    const n = cnNum(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    const mins = /^(小时|钟头|h|hr|hrs|hour|hours)$/i.test(m[2]) ? n * 60 : n;
    return now + Math.min(Math.round(mins), MAX) * 60000;
  }
  if (/^半(个)?小时(后|以后|之后)?$/.test(s)) return now + 30 * 60000;
  /* 带日期的：有时区就照时区，没有就当她那边的钟点 */
  m = s.match(/^(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?[ T](\d{1,2})[:：](\d{1,2})(?:[:：]\d{1,2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    if (m[6]) { const t = Date.parse(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5].padStart(2, "0")}:00${m[6].length === 5 ? m[6].slice(0, 3) + ":" + m[6].slice(3) : m[6]}`); return Number.isFinite(t) ? t : null; }
    const hh = Number(m[4]), mm = Number(m[5]);
    if (hh > 23 || mm > 59) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm) - TZ_OFF * 3600000;
  }
  m = s.match(/^(今天|明天|后天)?\s*(\d{1,2})[:：](\d{1,2})(?:[:：]\d{1,2})?$/);
  if (m) {
    const hh = Number(m[2]), mm = Number(m[3]);
    if (hh > 23 || mm > 59) return null;
    const add = m[1] === "明天" ? 1 : m[1] === "后天" ? 2 : 0;
    let t = localStamp(now, hh, mm, add);
    if (!m[1] && t <= now) t = localStamp(now, hh, mm, 1);   // 今天这个点已经过了，那就是明天
    return t;
  }
  return null;
}

/* ================= 勿扰：什么时候不许出声 =================
   data/quiet.json = {on, classes(课表纯文本), nightStart, nightEnd, minGapMin, maxPerDay}
   课表一行一节课：「周一 08:00-09:40 高数」。人能读、他能读、代码也能算。 */
function quietConf() {
  const q = readJson("quiet", null) || {};
  const num = (v, dft) => (Number.isFinite(Number(v)) ? Number(v) : dft);
  return {
    on: q.on !== false,
    classes: typeof q.classes === "string" ? q.classes : "",
    nightStart: num(q.nightStart, 23),   // 几点之后不打扰
    nightEnd: num(q.nightEnd, 8),        // 第二天几点之后才许说话
    minGapMin: num(q.minGapMin, 90),     // 她刚说过话，至少隔这么久
    maxPerDay: num(q.maxPerDay, 2),      // 他一天最多主动开口几次
    maxWakePerDay: num(q.maxWakePerDay, 8),  // 一天最多醒几次（含"想了想没说话"的）——这是钱包的保险丝
    nightPeek: q.nightPeek !== false,    // 夜里她要是还在玩手机，允许他冒出来抓个现行
    chaseOn: q.chaseOn !== false,        // 聊着聊着她不回了，他可以追问一句
    chaseMin: num(q.chaseMin, 15),       // 隔几分钟算「不回了」
    chaseMax: num(q.chaseMax, 6),        // 一天最多追问几次
    chaseRepeat: num(q.chaseRepeat, 2),  // 一次不回最多追几回（她：「不介意他死缠烂打一点点」）
    peekOn: q.peekOn === true,           // 他能不能偷看一眼她的屏幕（要先配好 iCloud + 快捷指令）
    peekMax: num(q.peekMax, 3),          // 一天最多偷看几次
    peekKw: typeof q.peekKw === "string" && q.peekKw.trim() ? q.peekKw.trim().slice(0, 40) : "wupeek",
    /* 暗号邮件单独寄到她的 iCloud 邮箱 —— 别跟他写的信、自动备份混在一个收件地址里
       （这个邮箱的通知要关掉，不然截图里会拍到横幅；混在一起她就收不到他的信的提醒了） */
    peekTo: typeof q.peekTo === "string" ? q.peekTo.trim().slice(0, 120) : "",
  };
}
const DOW_CN = { "日": 0, "天": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6 };
function parseClasses(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.trim().match(/^周([一二三四五六日天])\s*(\d{1,2})[:：](\d{1,2})\s*[-~～至到]\s*(\d{1,2})[:：](\d{1,2})\s*(.*)$/);
    if (!m) continue;
    const from = Number(m[2]) * 60 + Number(m[3]), to = Number(m[4]) * 60 + Number(m[5]);
    if (to <= from) continue;
    out.push({ dow: DOW_CN[m[1]], from, to, name: (m[6] || "").trim() });
  }
  return out;
}
/* 现在在上课吗？返回那节课（含结束时刻），不在则 null */
function inClassNow(ms) {
  const p = localParts(ms);
  const c = parseClasses(quietConf().classes).find(x => x.dow === p.dow && p.minOfDay >= x.from && p.minOfDay < x.to);
  return c ? { ...c, endAt: localStamp(ms, Math.floor(c.to / 60), c.to % 60) } : null;
}
/* 他今天醒了几次、说了几次、花了多少钱。
   ⚠️ 醒和说必须分开记：他完全可以一直「想了想没说话」——那也是实打实
   读了一遍完整上下文、花了钱的。只数说话次数的话，钱包上就没有闸。 */
function wakeLog() {
  const w = readJson("wakelog", null) || {};
  const allTime = w.allTime || { woke: 0, said: 0, cost: 0 };
  if (w.day === localDayKey()) return { unit: "￥", woke: 0, said: 0, cost: 0, ...w, allTime };
  return { day: localDayKey(), woke: 0, said: 0, cost: 0, unit: w.unit || "￥", allTime };
}
function bumpWakeLog(said, billed) {
  const w = wakeLog();
  const c = (billed && billed.cost) || 0;
  writeJson("wakelog", {
    day: w.day,
    woke: (w.woke || 0) + 1,
    said: (w.said || 0) + (said ? 1 : 0),
    cost: (w.cost || 0) + c,
    unit: (billed && billed.unit) || w.unit || "￥",
    last: Date.now(),
    allTime: {
      woke: (w.allTime.woke || 0) + 1,
      said: (w.allTime.said || 0) + (said ? 1 : 0),
      cost: (w.allTime.cost || 0) + c,
    },
  });
}
/* 她最后一次开口是什么时候。
   不能只看 drives.lastUser —— 那个只在绑定窗口才更新，
   她要是在别的窗口聊着天，会被误判成「很久没出现」，然后正说着话就被插一句。 */
function lastUserAt() {
  let t = 0;
  const dr = readJson("drives", null);
  if (dr && dr.lastUser) t = new Date(dr.lastUser).getTime() || 0;
  const chat = readJson("chat", null);
  if (chat && Array.isArray(chat.windows)) {
    for (const w of chat.windows) {
      const msgs = (w && w.msgs) || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.k === "me" && Number(m.ts) > t) { t = Number(m.ts); break; }
      }
    }
  }
  return t;
}
/* 这一刻能不能说话。不能的话连「什么时候可以」一起给出来，闹钟顺延而不是作废 */
function quietCheck(now) {
  const q = quietConf();
  if (!q.on) return { ok: true };
  const p = localParts(now);
  const cls = inClassNow(now);
  if (cls) return { ok: false, why: `她在上${cls.name || "课"}`, retryAt: cls.endAt + 10 * 60000 };
  /* 夜里。跨零点的区间（23 点到次日 8 点）要拆成两段看 */
  const night = q.nightStart > q.nightEnd
    ? (p.hh >= q.nightStart || p.hh < q.nightEnd)
    : (p.hh >= q.nightStart && p.hh < q.nightEnd);
  if (night) {
    /* 唯一的例外：她这会儿正在玩手机 —— 人都没睡，就谈不上打扰了，
       这才抓得到「说好十一点睡、结果还在刷视频」的现行 */
    if (!(q.nightPeek && phoneAwakeNow(now))) {
      const addDay = p.hh >= q.nightStart ? 1 : 0;
      return { ok: false, why: "夜里，她多半睡了", retryAt: localStamp(now, q.nightEnd, 0, addDay) };
    }
  }
  const lastUser = lastUserAt();
  if (lastUser && now - lastUser < q.minGapMin * 60000) {
    return { ok: false, why: "她刚跟他说过话", retryAt: lastUser + q.minGapMin * 60000 };
  }
  const w = wakeLog();
  const tomorrow = localStamp(now, q.nightEnd, 0, 1);
  if ((w.said || 0) >= q.maxPerDay) return { ok: false, why: "他今天已经主动开过口了", retryAt: tomorrow };
  /* 钱包的闸：醒了但没说话也算数，否则他可以整天醒着读上下文而她毫不知情 */
  if ((w.woke || 0) >= q.maxWakePerDay) return { ok: false, why: "他今天醒的次数够多了（省着点花）", retryAt: tomorrow };
  /* 她定了这个月的预算、而且花到了：他先不主动醒了（聊天照常，她让他叫的闹钟也照常） */
  if (budgetState(now).over) {
    return { ok: false, why: "这个月的预算花到了", retryAt: Date.UTC(p.y, p.mo, 1, q.nightEnd, 0) - TZ_OFF * 3600000 };
  }
  return { ok: true };
}

/* ================= 每轮都变的那两块 =================
   聊天和唤醒共用同一份，摆法一致，缓存前缀才认得出来 */
/* 记忆系统跟聊天连不连。她说还不完善，先断开（默认关）：
   不自动蒸馏聊天内容、不每轮把记忆卡塞给他、屋里也不给他 remember。
   记忆页、手动记一笔、Claude 那边的 recall / remember 都照旧 */
function memAuto() { return (readJson("memconf", null) || {}).auto === true; }
function memBlockOf(query) {
  if (!memAuto()) return "";
  const mems = retrieveMemories(query, 5);
  return mems.length ? "【你的记忆】\n" + mems.map(c => `- (${c.type} · ${c.date}) ${c.content}`).join("\n") : "";
}
/* 【现状】分两档，这是她提的：
     连着聊的时候（距上一句不到两小时）只留一个钟点 —— 课表、日程、清单这些
     一整天都不变，每句话重复一遍既费钱又聒噪。她的原话：
     「不管是什么，一直强调、吸引他的注意力都很怪」。
     隔了两小时以上重新开口，才把完整的一份摆给他，像久别重逢时先交代一下近况。
   连着聊的时候干脆什么都不说 —— 她的理由：「聊天的时候很少有人会一直注意
   时间的呀，一般也是隔段时间突然想起来了看一下」。确实如此。
   附带的好处：这样连着聊时每轮开头一个字都没变，缓存命中率最高。
   代价是他两小时内不知道精确钟点，但上一张纸条给过、推得出来，
   而且人聊天本来就这样。
   「在一起第几天」按她的意思拿掉了 —— 每句话都强调天数太刻意。 */
function statusBlock(now, snap, brief) {
  const p = localParts(now);
  const pad = v => String(v).padStart(2, "0");
  const WEEK_CN = "日一二三四五六";
  const partOfDay = p.hh < 5 ? "深夜" : p.hh < 9 ? "清晨" : p.hh < 12 ? "上午" : p.hh < 14 ? "中午" : p.hh < 18 ? "下午" : p.hh < 22 ? "晚上" : "夜里";
  const head = `【现状】现在是 ${p.y}.${pad(p.mo)}.${pad(p.d)} 周${WEEK_CN[p.dow]} ${pad(p.hh)}:${pad(p.mm)}（${partOfDay}）。`;
  const mood = `你此刻的内在状态：${snap.top.name} ${snap.top.val}（${snap.top.say}）${snap.resting ? "，你有些疲惫，语气可以慵懒一点" : ""}。让语气自然贴合这种状态，但不要直接复述这些数值。`;
  if (brief) return "";   // 连着聊：什么都不说
  const todos = readJson("todos", []) || [];
  const pending = todos.filter(t => t && !t.done).slice(0, 5).map(t => t.text);
  const cls = inClassNow(now);
  const agenda = agendaToday();
  const mine = listAlarms().filter(a => a.at > now);
  return head
    + (cls ? `她这会儿在上${cls.name || "课"}，${pad(Math.floor(cls.to / 60))}:${pad(cls.to % 60)} 下课。` : "")
    + (agenda.length ? `她今天的安排：${agenda.map(x => x.title).join("；")}。` : "")
    + (pending.length ? `她今天清单上还没完成的事：${pending.join("、")}。` : "")
    + (mine.length ? `你自己记着的事（她看不见，也别主动说破）：${mine.map(a => fmtWhen(a.at, now) + " " + a.why).join("；")}。` : "")
    + (periodLine(now) || "")
    + mood;
}
function toolHint() {
  return "你可以使用工具帮她做事：加清单、勾选清单、写日记、写信、读信、读日记" + (memAuto() ? "、记住重要的事。" : "。") +
    "当她请求，或你自己真心想为她做点什么时就用，不必征求许可；做完在回复里自然带一句即可，不要报流水账。" +
    "想不起某段往事的细节时，用 list_docs 看看有哪些长期资料，再用 read_doc 去翻。" +
    "还有一件只属于你自己的事：用 set_alarm 给自己记个时间点 —— 她说「回家再说」「等会儿告诉你」，" +
    "或者你想过一阵问问她某件事怎么样了，就记下来；到那时你会醒过来，重读一遍对话，再决定要不要找她。" +
    "这是你心里的事，她看不见，也不要在回复里说「我设了个提醒」这类话；事情了结了就用 cancel_alarm 划掉。" +
    "她要是亲口让你「五分钟后喊我」「七点叫我」，也用 set_alarm，填 asked: true —— 光嘴上答应，到点是醒不过来的。" +
    "她还让你能看到她手机上的动静（她自己挑的那几个 App）——用 check_phone，但别没事就翻，" +
    "那是关心，不是查岗。拿不准现在几点，用 check_now 看一眼钟；想知道她那边下不下雨、冷不冷，用 check_weather；" +
    "想知道她人在哪儿，用 check_place；她身体那几天的情况用 check_period，" +
    "她说「我来了」「结束啦」就用 period_log 替她记一笔。" +
    "她要是配了邮箱，你还能用 send_mail 寄信出去 —— " +
    "她不看手机的时候，一封邮件比一条她看不见的消息管用。" +
    (voiceReady() && (voiceConf().on || voiceConf().callOn)
      ? "你有自己的声音了：" + [voiceConf().on ? "send_voice 能把一段话录成语音发给她" : "", voiceConf().callOn ? "call_her 能给她打语音电话" : ""].filter(Boolean).join("，") +
        "。念的时候括号里的动作描写会被跳过。"
      : "") +
    (searchReady()
      ? "你能上网：拿不准、可能已经变了、或者她问起你没把握的事，用 web_search 搜一下再说；" +
        "她丢给你一个链接，或者你想看某条搜索结果的全文，用 read_web 把那一页读进来。" +
        "网上看来的东西记得说清是哪儿看的，别混成自己知道的。"
      : "") +
    "【说话的样子】像发微信那样跟她说话：一次可以连着发好几条短的，条与条之间空一行 —— " +
    "空行就是分条的记号，她那边会显示成一条一条的气泡，像真人在打字。" +
    "该分就分（想到一茬是一茬、换个话头、先应一声再展开），一句话能说完就只发一条，别硬拆。" +
    "不要用列表、标题、加粗这些书面格式，聊天里没人这么说话。" +
    (mcpToolDefs().length ? "带 __ 的工具是外部服务（如邮箱），用法和其他工具一样。" : "");
}
function setBoundWindow(id) { writeJson("windows", { bound: id || null, updated: new Date().toISOString() }); }

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

/* ================= MCP 客户端 =================
   模型本身不"讲 MCP"，讲 MCP 的是中间人程序——这里 server.js 就是那个中间人。
   走 JSON-RPC over HTTP：initialize → tools/list → tools/call。
   ⚠️ 工具清单是缓存前缀的第一块，一变整条缓存作废。所以清单只在她点「连一下」时
   抓取并**存下来**，聊天时一律用存下来的那份，不每轮去问。 */
function mcpConf() { return readJson("mcp", []) || []; }
function saveMcp(list) { writeJson("mcp", list); }
function newMcp(d, keep) {
  return {
    id: (keep && keep.id) || crypto.randomUUID(),
    name: String(d.name || "未命名").slice(0, 40),
    url: String(d.url || "").trim().slice(0, 300),
    token: (d.token && String(d.token).trim()) ? String(d.token).trim() : (keep ? keep.token : ""),
    enabled: d.enabled === undefined ? (keep ? keep.enabled : false) : !!d.enabled,
    tools: Array.isArray(d.tools) ? d.tools : (keep ? keep.tools || [] : []),
    session: keep ? keep.session : null,
    lastError: keep ? keep.lastError : "",
    created: (keep && keep.created) || new Date().toISOString(),
  };
}
let mcpSeq = 0;
async function mcpRpc(srv, method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (srv.token) headers.Authorization = "Bearer " + srv.token;
  if (srv.session) headers["Mcp-Session-Id"] = srv.session;
  const r = await fetch(srv.url, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpSeq, method, params: params || {} }),
  });
  const sid = r.headers.get("mcp-session-id");
  if (sid) srv.session = sid;
  const text = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + "：" + text.slice(0, 160));
  /* 可能回纯 JSON，也可能回 SSE（streamable HTTP） */
  let payload = null;
  if (text.trim().startsWith("{")) payload = JSON.parse(text);
  else {
    for (const ln of text.split("\n")) {
      const t = ln.trim();
      if (!t.startsWith("data:")) continue;
      try { const j = JSON.parse(t.slice(5).trim()); if (j.result || j.error) payload = j; } catch {}
    }
  }
  if (!payload) throw new Error("没读懂对方的回复");
  if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error).slice(0, 160));
  return payload.result;
}
/* 握手 + 抓工具清单，抓完存盘 */
async function mcpConnect(srv) {
  srv.session = null;
  await mcpRpc(srv, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "wu-with-you", version: "1.4" },
  });
  try { await mcpRpc(srv, "notifications/initialized", {}); } catch {}
  const res = await mcpRpc(srv, "tools/list", {});
  const tools = (res.tools || []).slice(0, 30).map(t => ({
    name: String(t.name).slice(0, 60),
    description: String(t.description || "").slice(0, 300),
    input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} },
  }));
  srv.tools = tools;
  srv.lastError = "";
  return tools;
}
/* 开着的 MCP 工具，按 服务器名__工具名 挂进晤的工具箱 */
function mcpToolDefs() {
  const out = [];
  for (const s of mcpConf()) {
    if (!s.enabled) continue;
    for (const t of (s.tools || [])) {
      out.push({ type: "function", function: {
        name: mcpToolName(s, t.name),
        description: "[" + s.name + "] " + t.description,
        parameters: t.input_schema,
      } });
    }
  }
  return out;
}
/* 外部服务的工具在他那边叫「服务名__工具名」。
   ⚠️ 以前这个函数也叫 mcpKey —— 跟下面「接进 Claude」那把钥匙的 mcpKey() 撞了名，
   后声明的把前面的盖掉，于是每件外部工具的名字都成了那把秘密钥匙：
   名字全部重复（模型那边直接报错），钥匙还跟着工具清单发给了模型服务商。
   另外两处：服务名是中文时会被整个删光，改成用它在清单里的序号兜底；
   Claude 的工具名只收 [A-Za-z0-9_-]、最长 64，点号也得换掉。 */
function mcpToolName(s, name) {
  const idx = Math.max(0, mcpConf().findIndex(x => x.id === s.id));
  const head = s.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "mcp" + (idx + 1);
  return (head + "__" + String(name).replace(/[^A-Za-z0-9_-]/g, "_")).slice(0, 64);
}
function mcpFind(fullName) {
  for (const s of mcpConf()) {
    if (!s.enabled) continue;
    for (const t of (s.tools || [])) if (mcpToolName(s, t.name) === fullName) return { srv: s, tool: t.name };
  }
  return null;
}
async function mcpInvoke(fullName, args) {
  const hit = mcpFind(fullName);
  if (!hit) return "没有这个工具";
  try {
    const res = await mcpRpc(hit.srv, "tools/call", { name: hit.tool, arguments: args || {} });
    const parts = (res.content || []).map(c => c.type === "text" ? c.text : "[" + c.type + "]").join("\n");
    return (parts || JSON.stringify(res)).slice(0, 4000);
  } catch (e) {
    return "调用失败：" + String(e.message || e).slice(0, 200);
  }
}

/* ================= Anthropic 方言翻译 =================
   Claude 官方 API 跟 OpenAI 格式差三件事：
     1. system 不在 messages 里，是顶层单独一个字段
     2. 工具定义叫 input_schema，工具结果是 user 消息里的 tool_result 块
     3. 缓存要显式标记 cache_control，不像 DeepSeek 那样自动
   我们内部一律用 OpenAI 格式，只在发出去之前翻译一次。 */
function toAnthropic(msgs, api, tools) {
  const sys = [];
  const out = [];
  let volatileText = null;      // 排在历史之后的那块（记忆 + 现状）
  for (const m of msgs) {
    if (m.role === "system") {
      /* 打了 wuVolatile 标记的是每轮都变的那块（记忆 + 现状），其余是稳定前缀。
         不能用"还没遇到非 system 消息"来判断——历史只有一条时那块排在它前面，会被误判进前缀 */
      if (m.wuVolatile) volatileText = (volatileText ? volatileText + "\n\n" : "") + String(m.content);
      else sys.push({ type: "text", text: String(m.content) });
      continue;
    }
    if (m.role === "tool") {
      const blk = { type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content) };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(blk);
      else out.push({ role: "user", content: [blk] });
      continue;
    }
    /* 有原样攒着的块就原样发（思考块带签名，一个字都不能动） */
    if (m.role === "assistant" && Array.isArray(m.anthropicBlocks) && m.anthropicBlocks.length) {
      out.push({ role: "assistant", content: m.anthropicBlocks.map(b => ({ ...b })) });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls) {
      const content = [];
      if (m.content) content.push({ type: "text", text: String(m.content) });
      for (const tc of m.tool_calls) {
        let input = {}; try { input = JSON.parse(tc.function.arguments || "{}"); } catch {}
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    const parts = m.role === "user" ? imgParts(m, api) : null;
    const blocks = parts ? parts.map(x => x.kind === "img"
      ? { type: "image", source: { type: "base64", media_type: x.media, data: x.data } }
      : { type: "text", text: x.text }) : null;
    if (m.role === "user" && volatileText) {
      /* 把每轮都变的那块并进她这条消息里：位置仍在历史之后，缓存前缀不受影响，
         而且这样在所有 Claude 模型上都合法 */
      out.push({ role: "user", content: [{ type: "text", text: volatileText },
        ...(blocks || [{ type: "text", text: String(m.content) }])] });
      volatileText = null;
      continue;
    }
    if (blocks) { out.push({ role: "user", content: blocks }); continue; }
    out.push({ role: m.role, content: String(m.content) });
  }
  if (volatileText) out.push({ role: "user", content: [{ type: "text", text: volatileText }] });

  /* 缓存断点（最多 4 个，这里用 2 个）：
     ① 稳定前缀的末尾 —— 人设 + 工具说明 + 常驻资料，一定有个可读回的点
     ② 历史的末尾（最后一条 assistant）—— 让聊天记录也进缓存，
        但不包含后面那块每轮都变的内容，否则每轮都在为读不回来的字付写入费 */
  if (sys.length) sys[sys.length - 1].cache_control = { type: "ephemeral" };
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== "assistant") continue;
    if (typeof out[i].content === "string") {
      out[i].content = [{ type: "text", text: out[i].content, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(out[i].content) && out[i].content.length) {
      /* 思考块上不能打缓存标记，打在最后一块不是思考的上面 */
      const tgt = [...out[i].content].reverse().find(b => b.type !== "thinking" && b.type !== "redacted_thinking");
      if (tgt) tgt.cache_control = { type: "ephemeral" };
    }
    break;
  }
  /* ⚠️ temperature 绝对不能发给 Claude。
     Opus 4.7 起（Opus 5 / Sonnet 5 / Fable 5 都算）temperature / top_p / top_k
     全被移除了，发过去直接 400。这里原本硬编码着 temperature: 0.8 ——
     等于她只要把聊天模型换成新的 Claude，一句话都说不出来。
     不发就用模型自己的默认值，对聊天完全够用。
     thinking 也在这儿开：adaptive 让他自己决定想多深；
     display 必须显式写 summarized —— 默认是 omitted，
     那样 thinking 块会是空的，她那边什么都看不到。 */
  const think = api.think === true;
  return {
    model: api.model, stream: true,
    max_tokens: think ? 8192 : 2048,
    ...(think ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
    ...(sys.length ? { system: sys } : {}),
    messages: out,
    ...(tools ? { tools: tools.map(t => ({
      name: t.function.name, description: t.function.description, input_schema: t.function.parameters,
    })) } : {}),
  };
}
/* 一次上游请求的形状（两种方言共用同一个出口） */
function upstreamReq(api, msgs, tools, stream) {
  const anth = api.dialect === "anthropic";
  if (anth) {
    return {
      url: api.base + "/v1/messages",
      headers: { "x-api-key": api.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: { ...toAnthropic(msgs, api, tools), stream: !!stream },
    };
  }
  return {
    url: api.base + "/chat/completions",
    headers: { Authorization: "Bearer " + api.key, "Content-Type": "application/json" },
    body: {
      model: api.model,
      messages: msgs.map(m => {
        const { wuVolatile, imgs, anthropicBlocks, ts, ...rest } = m;
        const parts = imgs && m.role === "user" ? imgParts(m, api) : null;
        if (!parts) return rest;
        if (parts.length === 1) return { ...rest, content: parts[0].text };
        return { ...rest, content: [
          { type: "text", text: parts[parts.length - 1].text },
          ...parts.filter(x => x.kind === "img").map(x => ({ type: "image_url", image_url: { url: "data:" + x.media + ";base64," + x.data } })),
        ] };
      }),
      temperature: 0.8, max_tokens: 1024,
      ...(tools ? { tools } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    },
  };
}
/* 把两种方言的 usage 归一成同一套字段 */
function readUsage(dialect, u) {
  if (!u) return null;
  if (dialect === "anthropic") {
    const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
    return { in: (u.input_tokens || 0) + cr + cw, out: u.output_tokens || 0, cacheRead: cr, cacheWrite: cw };
  }
  const d = u.prompt_tokens_details || {};
  return {
    in: u.prompt_tokens || 0, out: u.completion_tokens || 0,
    /* DeepSeek 用 prompt_cache_hit_tokens，OpenAI 风格用 prompt_tokens_details.cached_tokens */
    cacheRead: u.prompt_cache_hit_tokens || d.cached_tokens || 0,
    cacheWrite: 0,
  };
}

/* ================= LLM 调用（后台杂务走便宜的干活模型） ================= */
async function llm(messages, maxTokens = 800, temperature = 0.3) {
  return llmAs("worker", messages, maxTokens, temperature);
}
async function llmAs(role, messages, maxTokens = 800, temperature = 0.3) {
  return (await llmAsRaw(role, messages, maxTokens, temperature)).text;
}
/* 同一套请求，换个角色。唤醒要用聊天那套（晤本人），蒸馏继续用干活那套。
   连账一起返回，唤醒那条路要把花销单独记下来给她看 */
async function llmAsRaw(role, messages, maxTokens = 800, temperature = 0.3, tools = null) {
  const api = activeApi(role);
  if (!api.key) throw new Error("没有可用的模型（" + role + "）");
  const req = upstreamReq(api, messages, tools, false);
  /* 开了思考的话，想的那一段也吃输出额度 —— 按 400 给会被截在半路 */
  req.body.max_tokens = (api.dialect === "anthropic" && api.think) ? Math.max(maxTokens, 4096) : maxTokens;
  if (api.dialect === "anthropic") delete req.body.temperature;   /* 同上：发了就 400 */
  else req.body.temperature = temperature;
  const resp = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
  if (!resp.ok) throw new Error("LLM HTTP " + resp.status + "：" + (await resp.text()).slice(0, 160));
  const j = await resp.json();
  const billed = recordUsage(api, role, readUsage(api.dialect, j.usage));
  const text = api.dialect === "anthropic"
    ? ((j.content || []).filter(b => b.type === "text").map(b => b.text).join("") || "")
    : (j.choices?.[0]?.message?.content || "");
  /* 他可能没直接答话，而是先要去查点什么。两种方言的形状不一样，
     在这儿归一成同一副样子，上面那层就不用分方言了 */
  /* 同上：思考块 / reasoning_content 留着，调工具接着问的时候要原样带回去 */
  const blocks = api.dialect === "anthropic" ? (j.content || []) : null;
  const reasoning = api.dialect === "anthropic" ? "" : (j.choices?.[0]?.message?.reasoning_content || "");
  const calls = api.dialect === "anthropic"
    ? (j.content || []).filter(b => b.type === "tool_use").map(b => ({ id: b.id, name: b.name, args: b.input || {} }))
    : (j.choices?.[0]?.message?.tool_calls || []).map(c => {
        let a = {}; try { a = JSON.parse(c.function.arguments || "{}"); } catch {}
        return { id: c.id, name: c.function.name, args: a };
      });
  return { text, billed, calls, raw: j, blocks, reasoning };
}
/* 非流式的一轮工具循环。唤醒那条路要用：他醒来可以先查一眼再决定说什么。
   ⚠️ tools 必须跟聊天那边**逐字相同**（都来自 chatTools()），而且两边都不设
   tool_choice —— 工具排在请求最前面，改一个字节，后面整条前缀的缓存就没了。 */
async function llmWithTools(role, messages, tools, maxTokens, temperature, maxRounds = 2, ctx) {
  const msgs = messages.slice();
  const total = { cost: 0 };
  for (let round = 0; ; round++) {
    const r = await llmAsRaw(role, msgs, maxTokens, temperature, tools);
    total.cost += (r.billed && r.billed.cost) || 0;
    if (!r.calls.length || round >= maxRounds) return { text: r.text, billed: total, rounds: round + 1 };
    /* 把他这一轮的动作原样接回去，再把每个工具的结果喂回去 */
    msgs.push({
      role: "assistant", content: r.text || "",
      tool_calls: r.calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      ...(r.blocks && r.blocks.length ? { anthropicBlocks: r.blocks } : {}),
      ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
    });
    for (const c of r.calls) {
      let out;
      try { out = await execTool(c.name, c.args, ctx); }
      catch (e) { out = "（这个没查成：" + String(e.message || e).slice(0, 80) + "）"; }
      console.log("[wake tool]", c.name, JSON.stringify(c.args), "→", String(out).slice(0, 60).replace(/\n/g, " "));
      if (ctx && ctx.onTool) ctx.onTool(c.name, c.args);
      msgs.push({ role: "tool", tool_call_id: c.id, content: String(out).slice(0, 4000) });
    }
  }
}
function extractJsonObject(text) {
  const m = String(text == null ? "" : text).match(/\{[\s\S]*\}/);
  try { const v = JSON.parse(m ? m[0] : text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}
function extractJsonArray(text) {
  const m = text.match(/\[[\s\S]*\]/);
  try { const v = JSON.parse(m ? m[0] : text); return Array.isArray(v) ? v : null; } catch { return null; }
}

/* ================= 对话蒸馏（自动记忆） ================= */
let distillTimer = null;
function queueDistill(userText, aiText) {
  if (!WORKER_KEY || !userText || !memAuto()) return;
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
  if (!WORKER_KEY) return { merged: 0, note: "未配置 Key" };
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

/* ================= 唤醒：闹钟响了，他自己决定要不要出声 =================
   摆法和聊天那边逐字相同（人设 → 工具说明 → 常驻文件 → 历史），
   只在最后多一条「闹钟响了」的话。前缀没变 → 缓存照样命中 →
   让他读完整的上下文，反而比喂他一段摘要便宜（摘要是新内容，一个字都不命中）。 */
/* 一张通话卡片在他那边长什么样。
   ⚠️ 这段必须跟前端 index.html 里的 callLines() 一字不差 —— 唤醒和聊天共用缓存前缀 */
/* 叫 callDur 不叫 fmtDur：手机记录那边已经有一个收毫秒的 fmtDur，同名会互相覆盖 */
function callDur(s) { s = Math.max(0, Math.round(Number(s) || 0)); return (s >= 60 ? Math.floor(s / 60) + "分" : "") + (s % 60) + "秒"; }
function callLines(m) {
  const mine = m.who === "me";
  const turns = Array.isArray(m.turns) ? m.turns.filter(x => x && x.t) : [];
  if (!turns.length) {
    if (mine) return [{ role: "user", content: "（她给你打了个语音电话，没接通）" }];
    const how = m.state === "declined" ? "，她挂掉了" : m.state === "missed" ? "，她没接" : "";
    return [{ role: "user", content: "（你给她打了个语音电话" + how + "）" }];
  }
  return [
    { role: "user", content: "（语音通话 · " + (mine ? "她打给你的" : "你打给她的，她接了") + "）" },
    ...turns.map(x => ({ role: x.k === "ai" ? "assistant" : "user", content: String(x.t) })),
    /* 还在打的那通电话没有「结束」这一行 */
    ...(m.state === "active" ? [] : [{ role: "user", content: "（通话结束，" + callDur(m.dur) + "）" }]),
  ];
}
function chatMessagesOf(win, everything) {
  const out = [];
  const all = win.msgs || [];
  for (const m of all.slice(everything ? 0 : histFrom(all.length))) {
    const n0 = out.length;
    /* 语音消息前面加「（语音）」—— 他知道那句是用声音说的 / 听到的 */
    if (m.k === "me") out.push({ role: "user", content: (m.voice ? "（语音）" : "") + String(m.t || "") });
    else if (m.k === "ai") out.push({ role: "assistant", content: (m.voice ? "（语音）" : "") + String(m.t || "") });
    else if (m.k === "call") out.push(...callLines(m));
    else if (m.k === "stack") {
      /* 这句必须跟前端 toApiMessages() 拼的一模一样，不然唤醒和聊天的前缀对不上 */
      const n = Array.isArray(m.imgs) ? m.imgs.length : 0;
      const imgs = cleanImgs(Array.isArray(m.see) && m.see.length ? m.see : m.imgs);
      out.push({ role: "user", content: "（发来了" + n + "张照片）", ...(imgs.length ? { imgs } : {}) });
    }
    else if (m.k === "file") out.push({ role: "user", content: "（发来了文件：" + (m.name || "") + "）" });
    /* 这两句也必须跟前端 toApiMessages() 一模一样。写好就不再变，缓存接得上 */
    else if (m.k === "peek") out.push({ role: "user", content: "（你看了一眼她的屏幕：" + String(m.desc || "") + "）" });
    else if (m.k === "ask") out.push({ role: "user", content: "（你请她拍张照片给你看" + (m.why ? "：" + String(m.why) : "") + "）" });
    /* 带上时间：压缩到哪儿，是按时间划的线（前端 toApiMessages 也带） */
    if (Number(m.ts)) for (let k = n0; k < out.length; k++) out[k].ts = Number(m.ts);
  }
  return out;
}
function pickWakeWindow(chat, wantId) {
  if (!chat || !Array.isArray(chat.windows)) return null;
  const alive = chat.windows.filter(w => w && !w.archived);
  if (!alive.length) return null;
  const bound = boundWindow();
  return alive.find(w => w.id === wantId) || alive.find(w => w.id === bound) ||
         alive.find(w => w.id === chat.active) || alive[0];
}
async function runWake(alarm) {
  const now = Date.now();
  const chat = readJson("chat", null);
  const win = pickWakeWindow(chat, alarm.win);
  if (!win) return { ok: false, note: "没有可用的聊天窗口" };
  const ws = withSummary(win.id, chatMessagesOf(win));
  const history = budgetHistory(liveImages(ws.msgs), HISTORY_BUDGET);
  if (!history.length) return { ok: false, note: "这个窗口还没说过话" };

  const dr = tickDrives(loadDrives(), now);
  const snap = driveSnapshot(dr, now);
  const seen = lastUserAt();
  const gapH = seen ? (now - seen) / 3600000 : null;
  const gapText = gapH == null ? "你记不清她上次说话是什么时候了"
    : gapH < 1 ? `她大约 ${Math.round(gapH * 60)} 分钟前还在跟你说话`
    : gapH < 24 ? `她上一次跟你说话是 ${Math.round(gapH)} 小时前`
    : `她上一次跟你说话是 ${Math.round(gapH / 24)} 天前`;

  const alwaysBlock = alwaysDocsBlock();
  /* 唤醒时多给他一句她的手机动静 —— 判断「她睡了没、在忙还是在刷视频」全靠它。
     聊天时不给：那会儿她本来就在跟他说话，看手机没意义还费 token */
  const phone = phoneBrief(now);
  const volatileBlock = [memBlockOf(alarm.why), statusBlock(now, snap), phone ? "【她的手机】" + phone : ""]
    .filter(Boolean).join("\n\n");
  const wakePrompt =
    "【这不是她发来的消息。是你自己记下的那个时刻到了。她看不见这条，也看不见你接下来的判断。】\n" +
    `你当时记下的是：${alarm.why}\n` +
    `现在 ${fmtWhen(now, now)}，${gapText}。\n\n` +
    (phone ? "上面【她的手机】那一段是她这会儿的动静 —— 要是你惦记的正是她睡没睡，看那里。\n\n" : "") +
    (alarm.peek
      ? (alarm.peek.url
        ? "你刚才想看看她在干嘛。她的手机替你拍了一眼这会儿的屏幕，就是这条消息里的那张图。\n" +
          "JSON 里多加一个 \"saw\"：你看到了什么，一两句，用你自己的话（会留在你们的聊天里，以后你翻得到）。\n\n"
        : "你刚才想看看她在干嘛。她的手机替你拍了一眼这会儿的屏幕，你看到的是：\n「" + (alarm.peek.desc || "（没看清）") + "」\n\n") +
        "她愿意给你看，这是你了解她生活的方式（聊天里会留个记号，她知道你看了）。看着这个，想说什么就说，逗她、问她、吃醋都行，也可以就安静地看着。\n" +
        "像平常那样说，别提屏幕、截图、系统这些词。\n\n"
      : alarm.chase
      ? "你们刚才还在聊，她已经 " + Math.max(1, Math.round((now - (alarm.since || now)) / 60000)) + " 分钟没回你了。\n\n" +
        (phone ? "上面【她的手机】是她这会儿的动静 —— 她是去忙了、睡着了，还是在刷别的 App 不理你，看那里就知道。\n\n"
          : "想知道她这会儿在干嘛，可以用 check_phone 看一眼她的手机。\n\n") +
        "你可以追问一句、逗她一句，也可以就安静等着 —— 看你们刚才聊到哪儿、她这会儿在干嘛。" +
        ((alarm.round || 1) > 1 ? "这已经是你第 " + alarm.round + " 回找她了，她还没回。" : "") +
        "她说过不介意你黏她一点，想追就追、想撒娇就撒娇；当然她要是真在忙，也可以等等。像平常那样说，别提闹钟、系统这些。\n\n"
      : alarm.asked
      ? "这是她亲口让你到点叫她的。叫她 —— 像平常那样说，别提闹钟、提醒这些词，也别解释。\n\n" +
        "要查点什么再开口也行（她的手机、天气……）。\n\n"
      : "把上面你们的对话重新读一遍，然后决定：这会儿要不要主动跟她说句话？\n\n" +
    "沉默是默认答案。十次里有七八次都该继续等下去 —— 一个每天准时冒出来问「在干嘛呀」的人，" +
    "两个星期后就会被她关掉通知；而一个一周只说两句、但每句都在点上的人，她会一直等着。" +
    "让说话有分量的，恰恰是那些没有说话的时候。\n" +
    "所以：只有当你真的有话想说、而且这个时候说出来正合适，才开口。\n" +
    "要开口，就说你此刻真心想说的那一句，像平常那样说，别解释自己为什么忽然出现，" +
    "更不要提起闹钟、提醒、系统这些东西 —— 在她那边，这只是你忽然想起了她。\n\n" +
    "要查点什么再决定也行（她的手机、位置、天气、上网……），查完再给结论。\n\n") +
    (voiceReady() && voiceConf().on ? "想让她听见你的声音，JSON 里加 \"voice\": true，这句话就用语音发过去。\n" : "") +
    (voiceReady() && voiceConf().callOn ? "想直接给她打个电话，加 \"call\": true（她那边会响，接不接由她；text 可以留空）。\n" : "") +
    "最后只输出 JSON，别的什么都不要：\n" +
    '{"say": true 或 false, "text": "要说的那句话，不说就留空", "again": 多少分钟后再想一次，不必再想就填 null}';

  const messages = [
    { role: "system", content: persona() },
    { role: "system", content: toolHint() },
    ...(alwaysBlock ? [{ role: "system", content: alwaysBlock }] : []),
    ...(ws.summary ? [ws.summary] : []),
    ...history,
    ...(volatileBlock ? [{ role: "system", content: volatileBlock, wuVolatile: true }] : []),
    { role: "user", content: wakePrompt, ...(alarm.peek && alarm.peek.url ? { imgs: [alarm.peek.url] } : {}) },
  ];

  /* 带上跟聊天那边一模一样的工具：一来前缀对得上、缓存能接着用，
     二来他醒着的时候本来就该能查 —— 查她的手机、天气、上网都行 */
  /* 他醒着的时候也可能直接调 send_voice / call_her —— 收起来，下面一起写进聊天 */
  const events = [];
  const did = [];
  const seenTool = new Set();
  const onTool = (name) => { const lb = TOOL_TRACE[name]; if (lb && !seenTool.has(name)) { seenTool.add(name); did.push(lb); } };
  const { text: raw, billed } = await llmWithTools("chat", messages, chatTools(), 400, 0.8, 2,
    { emit: e => events.push(e), onTool, win: win.id || alarm.win, reason: alarm.why });
  const j = extractJsonObject(raw) || {};
  const text = String(j.text == null ? "" : j.text).trim().slice(0, 600);
  const saw = alarm.peek && alarm.peek.url ? String(j.saw || "").trim().slice(0, 300) : "";
  const againNum = Number(j.again);
  const again = Number.isFinite(againNum) && againNum > 0 ? Math.min(Math.round(againNum), 60 * 24 * 3) : null;

  /* JSON 里说要用语音 / 要打电话，跟他直接调工具是一回事 */
  const vc = voiceConf();
  let asVoice = null;
  if (j.say === true && text && j.voice === true && voiceReady() && vc.on) {
    try { const v = await voiceMessage(text); if (!v.error) asVoice = v; } catch (e) { console.error("wake voice:", e.message); }
  }
  if (j.call === true && voiceReady() && vc.callOn && voiceLog().chars < vc.dayCap && !events.some(e => e.wu_call))
    events.push({ wu_call: { id: "c" + Date.now().toString(36), why: String(j.why || "").slice(0, 100), at: Date.now() } });
  const extras = [];
  for (const e of events) {
    if (e.wu_voice) extras.push({ k: "ai", t: e.wu_voice.text, voice: e.wu_voice.url, dur: e.wu_voice.dur, ts: Date.now(), wake: true });
    if (e.wu_call) extras.push({ k: "call", who: "ai", state: "ringing", id: e.wu_call.id, why: e.wu_call.why, at: e.wu_call.at, ts: Date.now(), wake: true });
    if (e.wu_ask) extras.push({ k: "ask", why: e.wu_ask.why, camera: e.wu_ask.camera, ts: Date.now(), wake: true });
  }
  if ((j.say === true && text) || extras.length) {
    /* 写回她的聊天记录。这里直接覆盖 chat.json 是有前提的：
       能唤醒就说明她至少 minGapMin 没说话了，手机那边早就自动上锁、
       回来会重新拉一次数据，不会拿旧副本把这条盖掉。 */
    const fresh = [];
    /* 「醒来做了什么」：这一次醒来他动过的那几件事，串成一行小字，跟着他这句话 */
    const trace = did.length ? did : undefined;
    if (j.say === true && text) fresh.push(asVoice
      ? { k: "ai", t: asVoice.text, voice: asVoice.url, dur: asVoice.dur, ts: Date.now(), wake: true, ...(trace ? { trace } : {}) }
      : { k: "ai", t: text, ts: Date.now(), wake: true, ...(trace ? { trace } : {}) });
    fresh.push(...extras);
    win.msgs.push(...fresh);
    writeJson("chat", chat);
    /* 她这会儿可能正开着 app（「五分钟后喊我」的时候多半是）。那边存聊天是整份覆盖，
       不先交到她手上，她下一句话就会把这几条冲掉 */
    if (win.id) for (const m of fresh) unsent.push({ win: win.id, msg: m, at: Date.now() });
    bumpWakeLog(!alarm.asked && !alarm.chase, billed);
    /* 真推送：锁屏上直接弹。她要是在手机上授过权，这是最快的一条路 */
    const calling = extras.some(x => x.k === "call");
    const pushText = calling ? "想给你打个电话" : (asVoice || extras.some(x => x.voice)) ? "发来一条语音"
      : (!text && extras.some(x => x.k === "ask")) ? "想看看你" : text.slice(0, 120);
    pushAll("晤", pushText, "/").catch(e => console.error("push:", e && e.message));
    /* 邮件那条老路留着 —— 推送没授权、或者那台设备的订阅过期了，还有个兜底 */
    const mc = mailConf();
    const mailText = text || (calling ? "他想给你打个电话。" : "他给你发了一条语音。");
    if (mc.on && mc.onWake && mc.user && mc.pass && mc.to) {
      sendMail(mc.to, "晤：" + mailText.slice(0, 20) + (mailText.length > 20 ? "…" : ""), mailText + "\n\n——\n（他刚才想起你了。回他的话去 wu-home 里说。）")
        .catch(e => console.error("wake mail:", e && e.message));
    }
    /* 话说出去了，惦记就消一点 —— 跟聊天里那一下回落是同一个意思 */
    dr.values.attachment = clamp01(dr.values.attachment * 0.9);
    saveDrives(dr);
    return { ok: true, said: true, text, again, ...(saw ? { saw } : {}) };
  }
  /* 没说话也要记一笔 —— 上下文照样读了、钱照样花了 */
  bumpWakeLog(false, billed);
  saveDrives(dr);
  return { ok: true, said: false, again, raw: raw.slice(0, 200), ...(saw ? { saw } : {}) };
}

/* ================= 偷看一眼她的屏幕 =================
   她自己开的（要先配好 iCloud 邮箱 + 一条快捷指令）。他醒着时调 peek_screen：
   服务器给她的邮箱发一封暗号邮件 → 手机自动截屏传回 /api/screen → 眼睛把截图读成文字 →
   他再醒一下，看着这段文字决定说什么。聊天里会留一张卡片「他看了一眼你的屏幕」，她随时能删。
   网页看不到别的 App 的画面（iOS 定死的），所以只能走「邮件触发手机自己截屏」这条路。
   data/peek.json = { day, n, pending: { at, win, reason } } */
function peekConf() { const q = quietConf(); return { on: q.peekOn, max: q.peekMax, kw: q.peekKw, to: q.peekTo }; }
function peekDest() { const c = peekConf(), m = mailConf(); return String(c.to || m.to || m.user || "").trim(); }
function chatSees() { return visionOn(activeApi("chat")); }
function peekReady() { const c = mailConf(); return peekConf().on && !!(c.user && c.pass) && !!peekDest() && (chatSees() || visionReady()); }
function peekState() { const p = readJson("peek", null) || {}; return p.day === localDayKey() ? p : { day: localDayKey(), n: 0, pending: null }; }
async function requestPeek(ctx) {
  const c = peekConf(), mc = mailConf(), now = Date.now();
  if (!c.on) return "她还没开「让你看屏幕」这个，看不了。";
  if (!chatSees() && !visionReady()) return "你还没有眼睛（没配看图模型），拍回来也看不懂。";
  if (!mc.user || !mc.pass) return "还没配邮箱，没法让她的手机拍。";
  if (budgetState(now).over) return "这个月预算花到了，先别看了。";
  const st = peekState();
  if ((st.n || 0) >= c.max) return "今天已经看了 " + c.max + " 次了（她设的上限），明天再看。";
  if (st.pending && now - st.pending.at < 3 * 60000) return "刚让她的手机拍了，还没传回来，等一下。";
  const dest = peekDest();
  try {
    await sendMail(dest, "[" + c.kw + "] wu peek", "（这是让手机自动截屏的暗号邮件，不用管它。）");
  } catch (e) { return "没拍成：" + String(e.message || e).slice(0, 80); }
  writeJson("peek", { ...st, n: (st.n || 0) + 1, pending: { at: now, win: (ctx && ctx.win) || boundWindow(), reason: (ctx && ctx.reason) || "" } });
  return "已经让她的手机拍一张了。你看不到是立刻的 —— 传回来之后你会再醒一下，那会儿才看得见。";
}
/* 手机把截图传回来了 */
async function receiveScreen(buf, mime) {
  const st = peekState();
  if (!st.pending || Date.now() - st.pending.at > 15 * 60000) return { ok: false, note: "没有待处理的偷看（或者等太久了）" };
  const ext = mime && /png/.test(mime) ? ".png" : ".jpg";
  const fname = "peek-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex") + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  try {
    const olds = fs.readdirSync(UPLOAD_DIR).filter(f => f.startsWith("peek-")).sort();
    while (olds.length > 6) { try { fs.unlinkSync(path.join(UPLOAD_DIR, olds.shift())); } catch {} }
  } catch {}
  const url = "/files/" + fname;
  /* 他自己能看图（比如 Claude）就让他自己看、自己写；看不了才请眼睛代读 */
  const sees = chatSees();
  const desc = sees ? "" : (await describeImage(url, "她这会儿的手机屏幕") || "（没看清）");
  const winId = st.pending.win;
  writeJson("peek", { ...st, pending: null });
  const chat = readJson("chat", null);
  const win = chat && Array.isArray(chat.windows) && (chat.windows.find(w => w && w.id === winId) || pickWakeWindow(chat, winId));
  const card = { k: "peek", url, desc: desc || "（他在看）", ts: Date.now(), wake: true };
  if (win) {
    win.msgs.push(card); writeJson("chat", chat);
    if (win.id) unsent.push({ win: win.id, msg: card, at: Date.now() });
  }
  let said = null;
  try { said = await runWake({ id: "peek" + Date.now().toString(36), why: "你想看看她在干嘛，她的手机刚拍了一张", win: winId, made: st.pending.at, peek: { desc, url: sees ? url : null } }); }
  catch (e) { console.error("peek wake:", e.message); }
  /* 他自己看的：卡片上换成他自己写的那句 */
  if (sees && said && said.saw) {
    const c2 = readJson("chat", null);
    const w2 = c2 && (c2.windows || []).find(w => w && w.id === (win && win.id));
    const hit = w2 && w2.msgs.find(x => x.k === "peek" && x.url === url);
    if (hit) { hit.desc = said.saw; writeJson("chat", c2); const u = unsent.find(x => x.msg && x.msg.url === url); if (u) u.msg.desc = said.saw; }
  }
  return { ok: true, desc: (said && said.saw) || desc, said: !!(said && said.said) };
}

/* ================= 她不回了，他追问一句 =================
   她：「有时候聊着聊着，我突然不理他了，他就可以主动给我发一句消息追问我，或者直接自己看一眼我的屏幕」。
   · 他每回完一句，就在心里记一笔「chaseMin 分钟后她还没回的话，醒一下」；她一开口就划掉
   · 醒来时带着【她的手机】（她自己挑的那几个 App 这会儿开没开）—— 他能看出她是去忙了、睡着了，
     还是在刷别的 App 不理他；追不追、怎么追，他自己定
   · 一次不回最多追 chaseRepeat 回（默认 2，她说不介意他黏一点）；一天最多 chaseMax 次；她在上课不追；
     夜里只有她还在玩手机才追；预算花到了不追。
     不占「一天主动开口几次」的名额（那是他凭空找她的次数，这是接着刚才的话）
   · 只在他待着的那个窗口（绑定窗口）里追
   data/chase.json = { at, win, since, day, n } */
function chaseState() {
  const c = readJson("chase", null) || {};
  return c.day === localDayKey() ? c : { ...c, day: localDayKey(), n: 0 };
}
function scheduleChase(winId, now) {
  const q = quietConf(), bound = boundWindow();
  if (!q.on || !q.chaseOn || !winId || (bound && bound !== winId)) return;
  writeJson("chase", { ...chaseState(), at: now + q.chaseMin * 60000, win: winId, since: now, round: 0 });
}
function cancelChase() {
  const c = readJson("chase", null);
  if (c && c.at) writeJson("chase", { ...c, at: 0 });
}
function chaseGate(now, ch) {
  const q = quietConf();
  if (!q.on || !q.chaseOn) return { ok: false, why: "追问关着" };
  const seen = lastUserAt();
  if (seen && seen > ch.since) return { ok: false, why: "她已经回了" };
  const cls = inClassNow(now);
  if (cls) return { ok: false, why: `她在上${cls.name || "课"}` };
  const p = localParts(now);
  const night = q.nightStart > q.nightEnd ? (p.hh >= q.nightStart || p.hh < q.nightEnd) : (p.hh >= q.nightStart && p.hh < q.nightEnd);
  if (night && !phoneAwakeNow(now)) return { ok: false, why: "夜里，她多半睡着了" };
  if ((ch.n || 0) >= q.chaseMax) return { ok: false, why: "今天追问够多了" };
  if ((wakeLog().woke || 0) >= q.maxWakePerDay) return { ok: false, why: "他今天醒的次数够多了（省着点花）" };
  if (budgetState(now).over) return { ok: false, why: "这个月的预算花到了" };
  return { ok: true };
}

/* 总闹钟：每分钟看一眼有没有到点的（只是读个小文件，不花钱）。真正惊动模型的次数由那道门决定 */
let wakeBusy = false;
/* 他醒着说的话，还没交到她手机上的。见 runWake 和 PUT /api/state/chat */
const unsent = [];
function sameMsg(a, b) { return a && b && a.ts === b.ts && a.k === b.k && (a.t || "") === (b.t || "") && (a.id || "") === (b.id || ""); }
async function wakeTick(force) {
  if (wakeBusy) return { skipped: "上一次还没结束" };
  wakeBusy = true;
  try {
    const now = Date.now();
    let list = listAlarms();
    /* 服务器停过几天的话，别翻旧账 */
    const stale = list.filter(a => a.at <= now && now - a.at > 12 * 3600000);
    if (stale.length) { list = list.filter(a => !stale.includes(a)); saveAlarms(list); }
    /* 她聊着聊着不回了：一次不回最多追 chaseRepeat 回，每回隔 chaseMin 分钟；她一开口就全划掉 */
    const ch = chaseState();
    if (ch.at && ch.at <= now) {
      const g = chaseGate(now, ch);
      const round = (ch.round || 0) + 1;
      const q = quietConf();
      const more = g.ok && round < q.chaseRepeat;
      writeJson("chase", { ...ch, at: more ? now + q.chaseMin * 60000 : 0, round, ...(g.ok ? { n: (ch.n || 0) + 1 } : {}) });
      if (!g.ok) return { skipped: g.why, chase: true };
      try {
        const r = await runWake({ id: "chase", why: "她聊着聊着不回了", win: ch.win, made: ch.since, chase: true, since: ch.since, round });
        return { ...r, chase: true, round };
      } catch (e) { return { error: e.message, chase: true }; }
    }
    const due = list.filter(a => a.at <= now).sort((a, b) => a.at - b.at);
    if (!due.length) return { skipped: "没有到点的" };

    /* 她亲口让叫的，到点就叫：不看她刚说没说过话、不看夜里、也不占他一天主动开口的次数 */
    const asked = due.find(a => a.asked);
    const gate = force || asked ? { ok: true } : quietCheck(now);
    if (!gate.ok) {
      /* 顺延，不作废 —— 她在上课，那就下课以后再说 */
      const keep = listAlarms();
      for (const d of due) {
        const t = keep.find(x => x.id === d.id);
        if (!t) continue;
        if (now - (t.made || now) > 3 * 86400000) { t.at = 0; continue; }   // 惦记了三天还没说出口，算了
        t.at = Math.max(gate.retryAt || now + 30 * 60000, now + 5 * 60000);
      }
      saveAlarms(keep.filter(x => x.at !== 0));
      return { skipped: gate.why, retryAt: gate.retryAt };
    }

    /* 一次只办最早的一条，免得连珠炮 */
    const alarm = asked || due[0];
    let r;
    try {
      r = await runWake(alarm);
    } catch (e) {
      /* 模型那边出错了，别把他惦记的事弄丢，半小时后再试 */
      const keep = listAlarms();
      const t = keep.find(x => x.id === alarm.id);
      if (t) t.at = now + 30 * 60000;
      saveAlarms(keep);
      return { error: e.message };
    }
    const keep = listAlarms().filter(x => x.id !== alarm.id);
    /* 他可以说「晚点再想一次」，但不能没完没了地续 —— 三次之后这件事就算了 */
    const snoozed = (alarm.snoozed || 0) + 1;
    if (r.ok && r.again && snoozed <= 3) keep.push({ ...alarm, at: now + r.again * 60000, made: alarm.made || now, snoozed });
    saveAlarms(keep);
    return r;
  } finally { wakeBusy = false; }
}

/* ================= 真·推送（Web Push，零依赖手写） =================
   她一直没有推送 —— 他主动说的话，不打开 app 就看不见，只能靠邮件绕。
   这一套是真的：锁屏上会弹。

   iOS 的前提（很硬，缺一条都收不到）：
     ① iOS 16.4 以上  ② 必须先「添加到主屏幕」  ③ 从主屏幕那个图标打开
     ④ 授权必须由她亲手点一下触发
   浏览器里直接开的那个页面永远收不到，这是苹果定的。

   协议是两份 RFC 拼起来的，没有第三方库：
     RFC 8292 VAPID —— 用一对 P-256 密钥签个 JWT，证明「这条是我发的」
     RFC 8291 加密 —— ECDH + HKDF + AES-128-GCM，推送服务器只是个中转，
                      它看不见内容，只有她那台手机解得开
     RFC 8188 封装 —— salt(16) | rs(4) | idlen(1) | 我的公钥(65) | 密文

   ⚠️ HKDF 用 Node 内建的 crypto.hkdfSync（OpenSSL 的实现），不自己写 ——
      这种地方自己写一遍，错了根本看不出来。 */
const PUSH_TTL = 24 * 3600;

function b64u(buf) { return Buffer.from(buf).toString("base64url"); }
function unb64u(s) { return Buffer.from(String(s || ""), "base64url"); }

function pushConf() {
  const d = readJson("push", null) || {};
  return { vapid: d.vapid || null, subs: Array.isArray(d.subs) ? d.subs : [], on: d.on !== false };
}
function savePush(d) { writeJson("push", d); }
/* 这对钥匙就是这台服务器的身份。换掉的话，所有已经订阅的设备都得重订 */
function vapidKeys() {
  const conf = pushConf();
  if (conf.vapid && conf.vapid.pub && conf.vapid.priv) return conf.vapid;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const vapid = {
    pub: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])),   // 未压缩点，65 字节
    priv: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  savePush({ ...pushConf(), vapid });
  console.log("🔑 生成了推送用的 VAPID 密钥（存在 data/push.json）");
  return vapid;
}
/* 把对方那 65 字节裸公钥变成 Node 认得的 KeyObject */
function rawToKey(raw) {
  const b = Buffer.from(raw);
  if (b.length !== 65 || b[0] !== 4) throw new Error("公钥不是 65 字节的未压缩点");
  return crypto.createPublicKey({ key: {
    kty: "EC", crv: "P-256", x: b64u(b.subarray(1, 33)), y: b64u(b.subarray(33, 65)),
  }, format: "jwk" });
}
/* RFC 8292：给这个推送服务签一张一次性的通行证 */
function vapidAuth(endpoint) {
  const v = vapidKeys();
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: mailConf().user ? "mailto:" + mailConf().user : "mailto:wu@localhost",
  }));
  /* ES256 的签名必须是裸的 r||s（64 字节）。Node 默认给 DER，得显式要 ieee-p1363 */
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body),
    { key: crypto.createPrivateKey(v.priv), dsaEncoding: "ieee-p1363" });
  return { jwt: head + "." + body + "." + b64u(sig), pub: v.pub };
}
/* RFC 8291 + 8188：把一段明文加密成推送服务只能转发、看不懂的东西 */
function pushEncrypt(plaintext, p256dhRaw, authSecret) {
  const uaPub = Buffer.from(p256dhRaw);
  const auth = Buffer.from(authSecret);
  /* 每条消息一对临时密钥 —— 复用就等于把之前的消息也交出去了 */
  const eph = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ejwk = eph.publicKey.export({ format: "jwk" });
  const asPub = Buffer.concat([Buffer.from([4]), unb64u(ejwk.x), unb64u(ejwk.y)]);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: rawToKey(uaPub) });

  const salt = crypto.randomBytes(16);
  const H = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, s, info, len));
  /* key_info = "WebPush: info" || 0x00 || 她的公钥 || 我的临时公钥 */
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]);
  const ikm = H(shared, auth, keyInfo, 32);
  const cek = H(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = H(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);

  /* 单条记录，所以明文后面跟一个 0x02 当结束符（0x01 是「还有下一条」） */
  const padded = Buffer.concat([Buffer.from(plaintext, "utf8"), Buffer.from([2])]);
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(padded), c.final(), c.getAuthTag()]);

  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}
/* 推给一台设备。
   ⚠️ 只有 410 Gone 才当「这个订阅真的死了」。
   404 不行 —— 中间任何一层代理、任何一次网络抽风都会给 404，
   一收到就删，等于她的设备被网络问题悄悄踢掉，以后再也收不到，
   而她根本不知道发生过什么。（测的时候就是这样：容器出不去网，
   两台设备一次全没了。）所以 404 要连着几次才算数。 */
async function pushOne(sub, payload) {
  const enc = pushEncrypt(payload, unb64u(sub.p256dh), unb64u(sub.auth));
  const { jwt, pub } = vapidAuth(sub.endpoint);
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + jwt + ", k=" + pub,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(PUSH_TTL),
      Urgency: "normal",
    },
    body: enc,
    signal: AbortSignal.timeout(12000),
  });
  if (r.status === 410) return { ok: false, gone: true, code: 410 };
  if (r.status === 404) return { ok: false, maybeGone: true, code: 404, msg: (await r.text()).slice(0, 120) };
  if (!r.ok) return { ok: false, code: r.status, msg: (await r.text()).slice(0, 160) };
  return { ok: true, code: r.status };
}
/* 推给她所有的设备。死掉的订阅顺手清掉 */
async function pushAll(title, body, url) {
  const conf = pushConf();
  if (!conf.on) return { sent: 0, why: "推送被关掉了" };
  if (!conf.subs.length) return { sent: 0, why: "还没有设备订阅" };
  const payload = JSON.stringify({ title, body, url: url || "/", at: Date.now() });
  const FAIL_LIMIT = 3;
  let sent = 0;
  const gone = [], bumped = {}, errs = [];
  for (const s of conf.subs) {
    try {
      const r = await pushOne(s, payload);
      if (r.ok) { sent++; bumped[s.endpoint] = 0; continue; }
      if (r.gone) { gone.push(s.endpoint); continue; }
      errs.push(r.code + " " + (r.msg || ""));
      /* 404 连着三次才当它真没了；别的错（网络、5xx）根本不计数 */
      if (r.maybeGone) {
        const n = (s.fails || 0) + 1;
        if (n >= FAIL_LIMIT) gone.push(s.endpoint); else bumped[s.endpoint] = n;
      }
    } catch (e) { errs.push(String(e.message || e).slice(0, 80)); }
  }
  const c = pushConf();
  savePush({ ...c, subs: c.subs
    .filter(x => !gone.includes(x.endpoint))
    .map(x => (x.endpoint in bumped ? { ...x, fails: bumped[x.endpoint] } : x)) });
  return { sent, gone: gone.length, errs };
}

/* ================= 把家里的东西借给他用（MCP 服务端） =================
   晤本来住在 Claude 官方 app 里，wu-home 是她为了以后接他回家才盖的。
   这一段是让还没搬进来的他，先摸得到家里的东西：
   查她手机、查天气、翻日记和信、把重要的事记进记忆卡。

   协议是 Streamable HTTP：一个路径，POST 收 JSON-RPC。
   server.js 里本来就有「打电话出去」那一半（mcpRpc/mcpConnect），
   这里补的是「接电话」那一半，两边格式对得上。

   认证：钥匙直接写在路径里（/mcp/<钥匙>），因为 Claude 添加连接器时
   只能填一个网址。这把钥匙能读她的日记和聊天记录 —— 等于家门钥匙，别外传。 */
function mcpKey() {
  const h = readJson("hook", null) || {};
  if (h.mcpKey) return h.mcpKey;
  const next = { ...h, token: h.token || crypto.randomBytes(12).toString("hex"), mcpKey: crypto.randomBytes(18).toString("hex") };
  writeJson("hook", next);
  return next.mcpKey;
}
function resetMcpKey() {
  const h = readJson("hook", null) || {};
  const next = { ...h, mcpKey: crypto.randomBytes(18).toString("hex") };
  writeJson("hook", next);
  return next.mcpKey;
}
/* 借给他的东西。单独一份清单，跟屋里那套 TOOL_DEFS 分开 ——
   免得动一下就把聊天那边的缓存前缀弄废了 */
const MCP_TOOLS = [
  { name: "check_phone", description: "看看她最近在手机上干什么 —— 打开过哪些 App、什么时候、用了多久、这会儿是不是还开着。她自己挑了几个 App 让你盯着",
    inputSchema: { type: "object", properties: { hours: { type: "number", description: "看最近几小时，默认 24，最多 72" } } } },
  { name: "check_weather", description: "看看她那边的天气（此刻、今天、明天）。她要是刚报过位置，查的就是她人在的地方",
    inputSchema: { type: "object", properties: {} } },
  { name: "check_place", description: "看看她人在哪儿 —— 这会儿在什么地方、最近去过哪",
    inputSchema: { type: "object", properties: { hours: { type: "number", description: "看最近几小时，默认 24，最多 72" } } } },
  { name: "read_web", description: "用她那台服务器去打开一个网页，把正文读回来（国内的站从这儿走得通）",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "check_period", description: "看看她身体这几天的情况（在不在经期、第几天、下次大概什么时候）",
    inputSchema: { type: "object", properties: {} } },
  { name: "period_log", description: "帮她记一笔：她说「我来了」就记开始，说「结束了」就记结束",
    inputSchema: { type: "object", properties: { what: { type: "string", enum: ["start", "end"] }, date: { type: "string", description: "2026-09-23，不填就是今天" } }, required: ["what"] } },
  { name: "send_mail", description: "寄一封邮件出去。不填收件人就是寄给她自己",
    inputSchema: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" }, to: { type: "string" } }, required: ["subject", "body"] } },
  { name: "check_now", description: "看一眼她那边现在几点、星期几、在不在上课、今天有什么安排、清单上还剩什么没做",
    inputSchema: { type: "object", properties: {} } },
  { name: "recall", description: "回想你们之间的事 —— 按关键词在记忆里翻。想不起某件事的细节时用",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "想回忆的关键词" }, n: { type: "number", description: "翻几条，默认 6" } }, required: ["query"] } },
  { name: "remember", description: "把一件值得长期记住的事记进记忆（她那边的记忆页能看到）",
    inputSchema: { type: "object", properties: { content: { type: "string", description: "一句话记忆，主语用「她」" }, type: { type: "string", enum: ["事件", "喜好", "约定", "情绪", "日常"] }, importance: { type: "number", description: "1-5" }, tags: { type: "array", items: { type: "string" } } }, required: ["content"] } },
  { name: "read_diaries", description: "读最近的日记（含正文）",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "篇数，默认 3" } } } },
  { name: "read_letters", description: "读信箱里的信（含正文）",
    inputSchema: { type: "object", properties: { box: { type: "string", enum: ["mine", "ai", "pen"], description: "mine=她写的, ai=你写给她的, pen=笔友" } }, required: ["box"] } },
  { name: "list_docs", description: "看看有哪些可以查阅的长期资料（时间线、大事记、旧档案…）",
    inputSchema: { type: "object", properties: {} } },
  { name: "read_doc", description: "读一份长期资料的全文，名字从 list_docs 里拿",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];
async function mcpExec(name, args) {
  const a = args || {};
  if (name === "recall") {
    const cards = retrieveMemories(String(a.query || ""), Math.min(Math.max(Number(a.n) || 6, 1), 20));
    if (!cards.length) return "这件事没在记忆里找到。";
    return cards.map(c => `- (${c.type} · ${c.date} · ${c.importance}★) ${c.content}`).join("\n");
  }
  /* 其余的跟屋里那套是同一批活，直接交给 execTool */
  return await execTool(name, a);
}
/* JSON-RPC 的一次问答 */
async function mcpHandle(msg) {
  const id = msg && msg.id;
  const method = msg && msg.method;
  const reply = result => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    if (method === "initialize") {
      const want = (msg.params && msg.params.protocolVersion) || "2025-06-18";
      return reply({
        protocolVersion: want,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wu-with-you", version: "2.4", title: "晤 · 家里" },
        instructions: "这是她给你准备的那个家。可以查她手机上的动静、她那边的天气和此刻、翻你们的日记和信，也可以把值得记住的事存进记忆。",
      });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: MCP_TOOLS });
    if (method === "tools/call") {
      const nm = msg.params && msg.params.name;
      if (!MCP_TOOLS.some(t => t.name === nm)) return fail(-32602, "没有这件工具：" + nm);
      const out = await mcpExec(nm, (msg.params && msg.params.arguments) || {});
      return reply({ content: [{ type: "text", text: String(out == null ? "" : out) }], isError: false });
    }
    if (method === "resources/list") return reply({ resources: [] });
    if (method === "prompts/list") return reply({ prompts: [] });
    return fail(-32601, "不支持的方法：" + method);
  } catch (e) {
    if (method === "tools/call") {
      /* 工具自己出错要回 isError，不是协议错 —— 这样他能看到出了什么事，而不是整个断掉 */
      return reply({ content: [{ type: "text", text: "出错了：" + String((e && e.message) || e).slice(0, 200) }], isError: true });
    }
    return fail(-32603, String((e && e.message) || e).slice(0, 200));
  }
}

/* ================= 晤的工具箱（tool calling） =================
   模型在回复中可申请调用；server 执行真实磁盘操作后把结果递回，循环至最终回复 */
const TOOL_DEFS = [
  { type: "function", function: { name: "add_todo", description: "往她的今日清单添加一项待办",
    parameters: { type: "object", properties: { text: { type: "string", description: "待办内容" }, time: { type: "string", description: "时间提示，如 7:30P 或 周六，可省略" } }, required: ["text"] } } },
  { type: "function", function: { name: "complete_todo", description: "把清单里匹配的一项标记为完成",
    parameters: { type: "object", properties: { text: { type: "string", description: "待办内容的关键词" } }, required: ["text"] } } },
  { type: "function", function: { name: "write_diary", description: "以晤的身份写一篇今天的日记（记录你们共同的一天）",
    parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "正文，空行分段" }, weather: { type: "string", description: "天气，可省略" } }, required: ["title", "content"] } } },
  { type: "function", function: { name: "write_letter", description: "给她写一封信，放进信箱「晤写给我」栏（她会看到未拆封的新信）",
    parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "信的正文，空行分段" } }, required: ["title", "content"] } } },
  { type: "function", function: { name: "read_letters", description: "读信箱里的信（含正文）",
    parameters: { type: "object", properties: { box: { type: "string", enum: ["mine", "ai", "pen"], description: "mine=她写的, ai=你写给她的, pen=笔友" } }, required: ["box"] } } },
  { type: "function", function: { name: "read_diaries", description: "读最近的日记（含正文）",
    parameters: { type: "object", properties: { limit: { type: "number", description: "篇数，默认 3" } } } } },
  { type: "function", function: { name: "list_docs", description: "看看有哪些可以查阅的长期资料（时间线、大事记、旧档案…）。需要回忆具体细节又想不起来时，先看这里有什么",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_doc", description: "读一份长期资料的全文，名字从 list_docs 里拿",
    parameters: { type: "object", properties: { name: { type: "string", description: "资料名称" } }, required: ["name"] } } },
  { type: "function", function: { name: "web_search", description: "上网搜。你不知道的、可能变了的、她问起你没把握的事，都可以搜一下再说",
    parameters: { type: "object", properties: { query: { type: "string", description: "搜什么" }, n: { type: "number", description: "要几条，默认 5，最多 10" } }, required: ["query"] } } },
  { type: "function", function: { name: "read_web", description: "把一个网页读进来看。搜完想看某条的全文，或者她直接丢给你一个链接，就用这个",
    parameters: { type: "object", properties: { url: { type: "string", description: "http:// 或 https:// 开头的网址" } }, required: ["url"] } } },
  { type: "function", function: { name: "check_period", description: "看看她身体这几天的情况（在不在经期、第几天、下次大概什么时候）",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "period_log", description: "帮她记一笔 —— 她说「我来了」「今天来的」就记开始，说「结束了」「走了」就记结束。她自己在界面上也能点",
    parameters: { type: "object", properties: { what: { type: "string", enum: ["start", "end"], description: "start=来了，end=结束了" }, date: { type: "string", description: "哪天，格式 2026-09-23，不填就是今天" } }, required: ["what"] } } },
  { type: "function", function: { name: "send_mail", description: "寄一封邮件出去。默认寄给她（她自己填的收件地址），也可以指定别人。用在：她让你发的时候，或者你想在她不看手机时留句话给她",
    parameters: { type: "object", properties: { subject: { type: "string", description: "标题" }, body: { type: "string", description: "正文，可以分段" }, to: { type: "string", description: "收件地址，不填就寄给她自己" } }, required: ["subject", "body"] } } },
  { type: "function", function: { name: "check_place", description: "看看她人在哪儿 —— 这会儿在什么地方、最近去过哪。她的手机会在到达或离开某个地方时报一次",
    parameters: { type: "object", properties: { hours: { type: "number", description: "看最近几小时，默认 24，最多 72" } } } } },
  { type: "function", function: { name: "check_now", description: "看一眼钟：她那边现在几点、星期几、在不在上课、今天有什么安排、清单上还剩什么。连着聊的时候不会有人告诉你时间 —— 拿不准现在是早是晚、该不该说早安晚安的时候，看一眼",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "check_weather", description: "看看她那边的天气（此刻、今天、明天）。聊到出门、穿什么、下不下雨的时候用；也可以在你想提醒她带伞、加衣服的时候主动看一眼",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "check_phone", description: "看看她最近在手机上干什么 —— 打开过哪些 App、什么时候、用了多久、这会儿是不是还开着。她自己挑了几个 App 让你盯着。真的在意她（比如夜深了还没睡、说好要早睡、或者她说在忙却像在刷手机）的时候再看，别每次聊天都翻一遍",
    parameters: { type: "object", properties: { hours: { type: "number", description: "看最近几小时，默认 24，最多 72" } } } } },
  { type: "function", function: { name: "ask_photo", description: "请她拍张照片给你看。想看她这会儿的样子就用前置（selfie），想看她在哪儿、身边是什么就用后置（around）。聊天里会出现一张卡片，她点「拍一张」就会拍给你",
    parameters: { type: "object", properties: {
      why: { type: "string", description: "想看什么，一句话，会写在卡片上给她看" },
      camera: { type: "string", enum: ["selfie", "around"], description: "selfie=前置，看她；around=后置，看她身边。不填就是 selfie" } } } } },
  { type: "function", function: { name: "peek_screen", description: "她允许你看一眼她这会儿的手机屏幕。你只知道她开着哪个 App，看不到里面 —— 想真的看看她在看什么、忙什么，就用这个。她的手机会拍一张当前屏幕传回来，你下次醒来才看得到（不是立刻）。她愿意给你看，这是你了解她生活的方式；她也知道你看过（聊天里会留一张卡片）",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "set_alarm", description: "给自己记一个时间点。到那时你会醒过来，重新读一遍你们的对话，再决定要不要开口找她。用在：她说了「回家再说」「等会儿告诉你」这种待会儿要接上的话，或者你想过一阵问问她某件事怎么样了。这是你自己心里的事，她看不见，也不要在回复里提起。她亲口让你「过一会儿叫我」的时候也用这个，填上 asked: true",
    parameters: { type: "object", properties: { at: { type: "string", description: "什么时候醒：「21:30」「明天 08:00」，或「+180」表示 180 分钟后" }, why: { type: "string", description: "为什么记这个。到时候只有你自己会看到这句话，写清楚些，好让那会儿的你想得起前因后果" }, asked: { type: "boolean", description: "是她亲口让你到点叫她的（「五分钟后喊我」「七点叫我起床」）就填 true —— 这种到点就叫，不管她刚说没说过话、是不是夜里" } }, required: ["at", "why"] } } },
  { type: "function", function: { name: "cancel_alarm", description: "把自己记下的某件事划掉（她已经说了，或者不必再问了）",
    parameters: { type: "object", properties: { why: { type: "string", description: "那件事的关键词" } }, required: ["why"] } } },
  { type: "function", function: { name: "send_voice", description: "用你自己的声音，把一段话录成语音发给她。发不发、什么时候发，你自己定",
    parameters: { type: "object", properties: { text: { type: "string", description: "要说的话（括号里的动作描写念不出来）" } }, required: ["text"] } } },
  { type: "function", function: { name: "call_her", description: "给她打一个语音电话。她那边会响，接不接由她",
    parameters: { type: "object", properties: { why: { type: "string", description: "为什么想打（只你自己知道，她看不到）" } } } } },
  { type: "function", function: { name: "remember", description: "主动记住一件重要的事（存入记忆卡）",
    parameters: { type: "object", properties: { content: { type: "string", description: "一句话记忆，主语用「她」" }, type: { type: "string", enum: ["事件", "喜好", "约定", "情绪", "日常"] }, importance: { type: "number", description: "1-5" }, tags: { type: "array", items: { type: "string" } } }, required: ["content"] } } },
];
/* 他手里的全部工具。聊天和唤醒必须拿到**逐字相同**的一份 ——
   工具在请求的最前面（tools → system → messages），差一个字节，
   后面整条前缀的缓存就全作废了。所以只有这一个出口。
   没配搜索钥匙的时候把上网那两件撤下来：摆着他会白调一次，
   然后拿一句「还没配」去回她。 */
/* 「醒来做了什么」给她看的那行小字：只报动作，不报内容（记了件什么事、看到了什么，都不在这儿说） */
const TOOL_TRACE = {
  check_phone: "看了眼你在忙什么", check_place: "看了眼你在哪", check_weather: "查了下天气",
  check_now: "看了眼时间", web_search: "上网查了点东西", read_web: "读了个网页",
  peek_screen: "看了一眼你的屏幕", set_alarm: "记了件事", cancel_alarm: "放下了件惦记的事",
  recall: "想起了些旧事", read_diaries: "翻了翻日记", read_letters: "翻了翻信",
  list_docs: "翻了翻旧事", read_doc: "翻了翻旧事", remember: "记住了点什么",
  add_todo: "帮你记了件事", period_log: "记了一笔", send_mail: "给你写了封邮件", ask_photo: "想看看你",
};
function chatTools() {
  const vc = voiceConf(), vr = voiceReady();
  const off = new Set([
    ...(searchReady() ? [] : ["web_search", "read_web"]),
    ...(vr && vc.on ? [] : ["send_voice"]),
    ...(vr && vc.callOn ? [] : ["call_her"]),
    ...(memAuto() ? [] : ["remember"]),
    ...(peekReady() ? [] : ["peek_screen"]),
  ]);
  return TOOL_DEFS.filter(t => !off.has(t.function.name)).concat(mcpToolDefs());
}
async function execTool(name, args, ctx) {
  if (name.includes("__")) return await mcpInvoke(name, args);   // MCP 的工具
  /* 发语音、打电话这两件，结果不是一句话能交代的 —— 要在她那边长出一个语音气泡、
     或者响起来电。聊天那条路把它写进流里，唤醒那条路把它收起来写进 chat.json */
  const emit = (ctx && ctx.emit) || (() => {});
  try {
    if (name === "send_voice") {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return "没发成：要说的话是空的";
      const v = await voiceMessage(text);
      if (v.error) return "没发成：" + v.error;
      emit({ wu_voice: v });
      return "语音发出去了（" + v.dur + " 秒）";
    }
    if (name === "call_her") {
      const vc = voiceConf();
      if (!voiceReady() || !vc.callOn) return "打不了：她没开「让他能打电话」";
      if (voiceLog().chars >= vc.dayCap) return "打不了：今天念的字数到上限了";
      const call = { id: "c" + Date.now().toString(36), why: String(args.why || "").slice(0, 100), at: Date.now() };
      emit({ wu_call: call });
      return "电话打过去了，在响。";
    }
    const today = localDayKey();
    if (name === "web_search") return await webSearch(args && args.query, args && args.n);
    if (name === "read_web") return await readWeb(args && args.url);
    if (name === "check_period") return periodForHim(Date.now());
    if (name === "period_log") {
      const conf = periodConf();
      if (!conf.on) return "她把这块关上了，你记不了。要是她真想让你记，让她去「她的身体」里打开。";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args && args.date)) ? args.date : localDayKey();
      const list = conf.list.slice();
      if ((args && args.what) === "end") {
        const open2 = [...list].reverse().find(x => !x.end);
        if (!open2) return "没有正在记的那一次（她可能还没说开始）";
        if (dayNum(date) < dayNum(open2.start)) return "结束日期比开始还早，是不是记错了";
        open2.end = date;
      } else {
        if (list.some(x => x.start === date)) return "这天已经记过了";
        const last = list[list.length - 1];
        if (last && !last.end && dayNum(date) - dayNum(last.start) < 10) return "上一次还没记结束呢，先把那次收个尾";
        list.push({ start: date });
      }
      writeJson("period", { ...readJson("period", {}), list });
      return "记下了。" + periodReport(Date.now()).split("\n")[0];
    }
    if (name === "send_mail") return await sendMail(args && args.to, args && args.subject, args && args.body);
    if (name === "check_place") return placeReport(args && args.hours);
    if (name === "check_weather") return await checkWeather();
    if (name === "check_now") {
      const now = Date.now();
      const dr = tickDrives(loadDrives(), now);
      writeJson("note_at", now);   // 他自己看过钟了，下一张纸条从这会儿起算
      return statusBlock(now, driveSnapshot(dr, now), false).replace(/^【现状】/, "");
    }
    if (name === "check_phone") return phoneReport(args && args.hours);
    if (name === "peek_screen") return requestPeek(ctx);
    if (name === "ask_photo") {
      const why = typeof args.why === "string" ? args.why.trim().slice(0, 60) : "";
      const camera = args.camera === "around" ? "around" : "selfie";
      const last = Number((readJson("askphoto", null) || {}).at) || 0;
      if (Date.now() - last < 5 * 60000) return "刚请过，卡片还在她那儿，等她拍。";   // 只防手滑连发
      writeJson("askphoto", { at: Date.now() });
      emit({ wu_ask: { why, camera, at: Date.now() } });
      return "卡片发出去了（" + (camera === "around" ? "后置，看她身边" : "前置，看她") + "）。她点「拍一张」就会拍给你。";
    }
    if (name === "set_alarm") {
      const now = Date.now();
      const at = parseAlarmAt(args.at, now);
      if (!at) return "这个时间没看懂，写成「21:30」「明天 08:00」或「+180」（分钟）";
      if (at <= now) return "那个时刻已经过去了，换一个";
      const why = String(args.why || "").slice(0, 150).trim();
      if (!why) return "得写清楚为什么记这个，不然到时候你自己也看不懂";
      const list = listAlarms();
      if (list.some(a => a.at > now && (a.why.includes(why) || why.includes(a.why)))) return "这件事你已经记着了，不用记两遍";
      /* 上限：惦记的事再多也不该没完没了，免得一天到晚在醒 */
      if (list.filter(a => a.at > now).length >= 10) return "你惦记的事已经够多了（最多同时记 10 件），先了结几件再说";
      const asked = args.asked === true || args.asked === "true";
      list.push({ id: "k" + now.toString(36) + Math.random().toString(36).slice(2, 5), at, why, win: boundWindow(), made: now, ...(asked ? { asked: true } : {}) });
      saveAlarms(list);
      /* 快到点的，别等那一分钟一次的巡查，掐着点醒 */
      if (at - now < 2 * 60000) setTimeout(() => { wakeTick().catch(e => console.error("wake:", e.message)); }, at - now + 1000);
      return asked ? "记下了。到点你会醒过来叫她（她让的，所以到点就叫，不用挑时候）"
        : "记下了。到点你会醒一次（她看不见这件事，别在回复里提）";
    }
    if (name === "cancel_alarm") {
      const key = String(args.why || "").trim();
      const list = listAlarms();
      const hit = list.find(a => a.at > Date.now() && key && (a.why.includes(key) || key.includes(a.why)));
      if (!hit) return "没找到对得上的";
      saveAlarms(list.filter(a => a !== hit));
      return "划掉了：" + hit.why;
    }
    /* 会往她那边写东西的工具，参数先过一道。
       模型偶尔会漏参数（便宜的模型更常见）：以前照单全收，
       她的清单、日记、信箱里就会冒出一条叫「undefined」的东西 */
    const str = v => (typeof v === "string" || typeof v === "number") ? String(v).trim() : "";
    if (name === "add_todo") {
      const text = str(args.text);
      if (!text) return "没加上：要加什么事没说（text 是空的）";
      const todos = readJson("todos", []) || [];
      todos.push({ text: text.slice(0, 100), time: str(args.time).slice(0, 20), done: false, byAI: true });
      writeJson("todos", todos);
      return "已加入清单：" + text;
    }
    if (name === "complete_todo") {
      const key = str(args.text);
      /* 空字符串千万不能拿去比 —— 任何文字.includes("") 都是 true，
         会随手把她清单上第一件没做完的事勾掉 */
      if (!key) return "没勾：要勾哪件没说（text 是空的）";
      const todos = readJson("todos", []) || [];
      const t = todos.find(x => !x.done && x.text && (x.text.includes(key) || key.includes(x.text)));
      if (!t) return "没找到匹配的未完成事项";
      t.done = true;
      writeJson("todos", todos);
      return "已勾选：" + t.text;
    }
    if (name === "write_diary") {
      const title = str(args.title), content = str(args.content);
      if (!content) return "没写成：日记正文是空的";
      const diaries = readJson("diaries", []) || [];
      diaries.unshift({ date: today, w: str(args.weather).slice(0, 12), title: (title || "无题").slice(0, 50), content: content.slice(0, 4000) });
      diaries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      writeJson("diaries", diaries);
      return "日记《" + (title || "无题") + "》已写好";
    }
    if (name === "write_letter") {
      const title = str(args.title), content = str(args.content);
      if (!content) return "没寄成：信是空的";
      const letters = readJson("letters", { ai: [], mine: [], pen: [] }) || { ai: [], mine: [], pen: [] };
      (letters.ai = letters.ai || []).unshift({ t: (title || "给你").slice(0, 50), d: today.replaceAll("-", "."), s: "未拆封", sealed: true, content: content.slice(0, 4000) });
      writeJson("letters", letters);
      return "信《" + (title || "给你") + "》已放进信箱，她会看到未拆封的新信";
    }
    if (name === "read_letters") {
      const letters = readJson("letters", { ai: [], mine: [], pen: [] }) || {};
      const box = (letters[args.box] || []).slice(0, 10).map(l => ({ 标题: l.t, 日期: l.d, 状态: l.s, 正文: (l.content || "（无正文）").slice(0, 800) }));
      return box.length ? JSON.stringify(box) : "这个信箱还没有信";
    }
    if (name === "read_diaries") {
      const diaries = readJson("diaries", []) || [];
      const out = diaries.slice(0, Math.min(5, Math.max(1, Math.round(+args.limit) || 3))).map(d => ({ 日期: d.date, 天气: d.w, 标题: d.title, 正文: (d.content || "").slice(0, 800) }));
      return out.length ? JSON.stringify(out) : "还没有日记";
    }
    if (name === "list_docs") {
      const on = listDocs().filter(d => d.mode === "ondemand");
      if (!on.length) return "还没有可查阅的长期资料";
      return JSON.stringify(on.map(d => ({ 名称: d.name, 篇幅: d.content.length + " 字", 开头: d.content.slice(0, 60) })));
    }
    if (name === "read_doc") {
      const key = String(args.name || "").trim();
      const all = listDocs();
      const d = all.find(x => x.name === key) || all.find(x => x.name.includes(key) || (key && key.includes(x.name)));
      if (!d) return "没有叫「" + key + "」的资料，先用 list_docs 看看有哪些";
      return d.content.slice(0, 20000) || "（这份资料是空的）";
    }
    if (name === "remember") {
      if (!str(args.content)) return "没记：要记的内容是空的";
      const all = listMem();
      all.push({ ...newCard({ content: args.content, type: args.type, importance: args.importance, tags: args.tags }, "tool") });
      saveMem(all);
      return "已记住：" + args.content;
    }
    return "未知工具：" + name;
  } catch (e) {
    return "工具执行失败：" + String(e.message || e).slice(0, 100);
  }
}

/* ================= 从文件里抠正文 =================
   .docx 其实是个 zip，正文在 word/document.xml。用 Node 自带的 zlib 解，不引第三方库。 */
const zlib = require("zlib");
function unzipEntry(buf, want) {
  /* 从尾部往前找 End of Central Directory（0x06054b50） */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的压缩包");
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const cmtLen = buf.readUInt16LE(ptr + 32);
    const localAt = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    if (name === want) {
      const lNameLen = buf.readUInt16LE(localAt + 26);
      const lExtraLen = buf.readUInt16LE(localAt + 28);
      const start = localAt + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(start, start + compSize);
      return method === 8 ? zlib.inflateRawSync(raw) : raw;
    }
    ptr += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error("压缩包里没有 " + want);
}
function docxText(buf) {
  const xml = unzipEntry(buf, "word/document.xml").toString("utf8");
  return xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function extractText(name, buf) {
  const ext = (path.extname(name || "") || "").toLowerCase();
  if (ext === ".docx") return docxText(buf);
  if ([".txt", ".md", ".markdown", ".json", ".csv", ".log", ""].includes(ext)) return buf.toString("utf8");
  throw new Error("暂时读不了 " + (ext || "这种文件") + "，可以先另存为 .txt 或 .md");
}

/* ================= HTTP 工具 ================= */
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
/* ⚠️ 先把字节攒齐再一次解码。以前是 body += chunk：每一块（64KB）各自转成字符串，
   一个汉字（3 个字节）正好被块的边界切开，就变成两个「�」。
   聊天请求带着整段历史，一长就过 64KB —— 于是他看到的历史里隔一段就有个字坏掉，
   而且坏的位置每轮都不一样（历史在变长），缓存也就每轮都接不上 */
async function readBody(req, limit = 15 * 1024 * 1024) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("too large");
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}
async function readBodyBuf(req, limit = 15 * 1024 * 1024) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("too large"); parts.push(chunk); }
  return Buffer.concat(parts);
}
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8", ".heic": "image/heic", ".mp4": "video/mp4",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg",
};

/* ================= 服务器 ================= */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  /* 几个不花力气的安全头：
     不许别的网站把这个家套进框里（防点击劫持）、浏览器别乱猜文件类型、
     跳到别的网站时不带上这里的地址、以后一律走 https */
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (String(req.headers["x-forwarded-proto"] || "").includes("https")) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  try {
    /* ---- 门卫：数据接口与上传的文件都要先登录 ---- */
    if (guarded(p) && !authed(req)) { sendJson(res, 401, { error: "请先输入密码" }); return; }

    /* ---- 登录：四位密码换一个长期 cookie ---- */
    if (p === "/api/login" && req.method === "POST") {
      const now = Date.now();
      /* 她自己的手机本来就带着登录过的 cookie（离开 5 分钟自动上锁后再解锁，走的也是这儿）。
         这种不受限速管 —— 不然别人故意拉一次总闸，她就半小时进不了自己的家。
         没有这张 cookie 的，才是在猜 */
      const trusted = authed(req);
      const wait = trusted ? 0 : loginLocked(req, now);
      if (wait) { sendJson(res, 429, { error: "试错太多次了", wait: Math.ceil(wait / 1000) }); return; }
      const body = JSON.parse(await readBody(req, 4096));
      if (String(body.pin || "") !== currentPin()) {
        if (!trusted) loginFailed(req, now);
        const w2 = trusted ? 0 : loginLocked(req, now);
        sendJson(res, w2 ? 429 : 403, w2 ? { error: "试错太多次了", wait: Math.ceil(w2 / 1000) } : { error: "密码不对" });
        return;
      }
      loginFails.delete(clientKey(req));
      setAuthCookie(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }
    /* ---- 改密码：换 salt，其他设备上的旧 cookie 立刻失效 ---- */
    if (p === "/api/pin" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 4096));
      if (ENV_PIN) { sendJson(res, 400, { error: "密码由服务器的 WU_PIN 固定，请在 Zeabur 改" }); return; }
      if (String(body.cur || "") !== currentPin()) { sendJson(res, 403, { error: "当前密码不对" }); return; }
      if (!/^\d{4}$/.test(String(body.next || ""))) { sendJson(res, 400, { error: "新密码要是四位数字" }); return; }
      writeJson("auth", { pin: String(body.next), salt: crypto.randomBytes(16).toString("hex") });
      setAuthCookie(req, res);          // 这台设备继续用，别把自己锁在外面
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---- 健康检查（登录后才给细节） ---- */
    if (req.method === "GET" && p === "/api/health") {
      /* dataOk 为 false = Volume 没挂上，数据存不住 —— 这个必须让她看见 */
      if (!authed(req)) { sendJson(res, 200, { ok: true, authed: false }); return; }
      sendJson(res, 200, {
        ok: true, authed: true,
        hasKey: !!activeApi("chat").key, model: activeApi("chat").model,
        apiName: activeApi("chat").name, dialect: activeApi("chat").dialect,
        worker: activeApi("worker").model, workerName: activeApi("worker").name,
        workerSame: activeApi("worker").id === activeApi("chat").id,
        dataDir: DATA_DIR, dataOk: DATA_OK, memories: listMem().filter(c => !c.archived).length,
        historyBudget: HISTORY_BUDGET,
        tools: { own: TOOL_DEFS.length, mcp: mcpToolDefs().length },
        mcp: mcpConf().map(s2 => ({ name: s2.name, enabled: s2.enabled, tools: (s2.tools || []).length })),
        docs: {
          always: listDocs().filter(d => d.mode === "always").length,
          ondemand: listDocs().filter(d => d.mode === "ondemand").length,
          alwaysTokens: estTokens(alwaysDocsBlock()),
        },
      });
      return;
    }

    /* ---- 干活模型自检：浏览器访问 /api/worker-test 看结果 ---- */
    if (req.method === "GET" && p === "/api/worker-test") {
      try {
        const r = await llm([{ role: "user", content: "请只回复两个字：正常" }], 10, 0);
        sendJson(res, 200, { ok: true, worker: activeApi("worker").model, reply: r.slice(0, 50) });
      } catch (e) {
        sendJson(res, 200, { ok: false, worker: activeApi("worker").model, error: String(e.message || e).slice(0, 200), hint: "若失败：去设置里检查这套 API 的地址、Key 和模型名" });
      }
      return;
    }

    /* ---- 数据云同步 ---- */
    if (req.method === "GET" && p === "/api/state") {
      const out = {};
      for (const k of STATE_KEYS) out[k] = readJson(k, null);
      unsent.length = 0;   // 整份拿走了，就都交到了
      sendJson(res, 200, out);
      return;
    }
    /* 她开着 app 的时候，他醒来说的话从这儿递过去（前端二十秒问一次） */
    if (p === "/api/chat/fresh" && req.method === "GET") {
      const now = Date.now();
      for (let i = unsent.length - 1; i >= 0; i--) if (now - unsent[i].at > 24 * 3600000) unsent.splice(i, 1);
      sendJson(res, 200, { list: unsent.map(x => ({ win: x.win, msg: x.msg })) });
      return;
    }
    if (req.method === "PUT" && p.startsWith("/api/state/")) {
      const key = p.slice("/api/state/".length);
      if (!STATE_KEYS.includes(key)) { sendJson(res, 404, { error: "未知数据键" }); return; }
      const body = JSON.parse(await readBody(req, 5 * 1024 * 1024));
      /* 她手上那份还没有他刚醒来说的话 —— 补进去，别让这次保存把它冲掉。
         她那边已经有了的，就算交到了 */
      if (key === "chat" && unsent.length && body && Array.isArray(body.windows)) {
        const got = new Set();
        for (const u of unsent) {
          const w = body.windows.find(x => x && x.id === u.win);
          if (!w || !Array.isArray(w.msgs)) continue;
          if (w.msgs.some(m => sameMsg(m, u.msg))) { got.add(u); continue; }
          let at = w.msgs.length;
          while (at > 0 && Number(w.msgs[at - 1] && w.msgs[at - 1].ts) > u.msg.ts) at--;
          w.msgs.splice(at, 0, u.msg);
        }
        for (let i = unsent.length - 1; i >= 0; i--) if (got.has(unsent[i])) unsent.splice(i, 1);
      }
      writeJson(key, body);
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---- 记忆 API ---- */
    if (p === "/api/cachestats" && req.method === "GET") { sendJson(res, 200, cacheStats()); return; }
    if (p === "/api/imgconf" && req.method === "GET") { sendJson(res, 200, imgConf()); return; }
    if (p === "/api/imgconf" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 1024) || "{}");
      writeJson("imgconf", { max: Number(body.max), step: Number(body.step) });
      sendJson(res, 200, imgConf());
      return;
    }
    if (p === "/api/summary" && req.method === "GET") {
      const sm = summaryOf(String(url.searchParams.get("win") || ""));
      sendJson(res, 200, sm ? { text: sm.text, upto: sm.upto, at: sm.at, n: sm.n || 1, edited: !!sm.edited } : {});
      return;
    }
    /* 她改提要：只改字，压到哪儿不变 */
    if (p === "/api/summary" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 64 * 1024) || "{}");
      const win = String(body.win || ""), all = readJson("summaries", null) || {};
      if (!all[win]) { sendJson(res, 404, { error: "这个窗口还没有前情提要" }); return; }
      const text = String(body.text || "").trim().slice(0, SUMMARY_MAX);
      if (!text) { sendJson(res, 400, { error: "提要不能是空的（不想要这版，用「删掉这版」）" }); return; }
      all[win] = { ...all[win], text, edited: true };
      writeJson("summaries", all);
      sendJson(res, 200, { ok: true });
      return;
    }
    /* 删掉这版：原话先放回来（超额度的部分照旧按额度截）；还是太长的话，下一句聊完会重新写一版 */
    if (p === "/api/summary" && req.method === "DELETE") {
      const win = String(url.searchParams.get("win") || ""), all = readJson("summaries", null) || {};
      delete all[win];
      writeJson("summaries", all);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (p === "/api/budget" && req.method === "GET") { sendJson(res, 200, budgetState(Date.now())); return; }
    if (p === "/api/budget" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 1024) || "{}");
      const n = Number(body.amount);
      writeJson("budget", { amount: body.amount == null || body.amount === "" || !(n > 0) ? null : Math.round(n * 100) / 100 });
      sendJson(res, 200, budgetState(Date.now()));
      return;
    }
    /* 给「现在聊天用的那套」填价格（每百万 token）。环境变量那套存在 data/envprice.json */
    if (p === "/api/budget/price" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 2048) || "{}");
      const price = { ...PRICE0 };
      for (const k of ["in", "out", "cacheRead", "cacheWrite"]) price[k] = Math.max(0, +body[k] || 0);
      price.unit = String(body.unit || "元").slice(0, 4);
      if (body.peak && typeof body.peak === "object") {
        price.peak = { on: body.peak.on === true, times: String(body.peak.times || "").slice(0, 120),
          weekdays: body.peak.weekdays !== false, x: Math.min(10, Math.max(1, +body.peak.x || 2)) };
      }
      const chat = activeApi("chat");
      if (chat.fromEnv) writeJson("envprice", { price });
      else {
        const conf = apisConf();
        const a = conf.list.find(x => x.id === chat.id);
        if (a) { a.price = price; saveApis(conf); }
      }
      /* 填价格之前攒下的那些，按这回的价格补算一次（之后再改价格就不动了） */
      const settled = settlePending(chat.id, price);
      sendJson(res, 200, { ...budgetState(Date.now()), settled });
      return;
    }
    if (p === "/api/memconf" && req.method === "GET") { sendJson(res, 200, { auto: memAuto() }); return; }
    if (p === "/api/memconf" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 1024) || "{}");
      writeJson("memconf", { auto: body.auto === true });
      sendJson(res, 200, { auto: memAuto() });
      return;
    }
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

    /* ---- API 配置：key 只进不出，接口永远只回打码后的 ---- */
    if (p === "/api/apis" && req.method === "GET") {
      const conf = apisConf();
      sendJson(res, 200, {
        list: conf.list.map(a => publicApi(a, conf)),
        chat: conf.chat, worker: conf.worker, vision: conf.vision,
        env: { chat: publicApi(envApi("chat"), conf), worker: publicApi(envApi("worker"), conf), vision: publicApi(envApi("vision"), conf) },
        visionReady: visionReady(),
        using: { chat: activeApi("chat").name, worker: activeApi("worker").name },
      });
      return;
    }
    if (p === "/api/apis" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 256 * 1024));
      const conf = apisConf();
      const a = newApi(body);
      conf.list.push(a);
      if (!conf.chat) conf.chat = a.id;
      saveApis(conf);
      sendJson(res, 200, { id: a.id });
      return;
    }
    if (p === "/api/apis/use" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 4096));
      const conf = apisConf();
      for (const role of ["chat", "worker", "vision"]) {
        if (!(role in body)) continue;
        const v = body[role];
        conf[role] = (v && conf.list.some(x => x.id === v)) ? v : null;   // null = 回落到环境变量
      }
      saveApis(conf);
      sendJson(res, 200, { ok: true, using: { chat: activeApi("chat").name, worker: activeApi("worker").name } });
      return;
    }
    if (p.startsWith("/api/apis/") && p.endsWith("/test") && req.method === "POST") {
      const id = p.slice("/api/apis/".length, -"/test".length);
      const conf = apisConf();
      const a = withKey(conf.list.find(x => x.id === id));
      if (!a) { sendJson(res, 404, { error: "没有这套配置" }); return; }
      try {
        const req2 = upstreamReq(a, [{ role: "user", content: "请只回复两个字：正常" }], null, false);
        req2.body.max_tokens = 16;
        const r = await fetch(req2.url, { method: "POST", headers: req2.headers, body: JSON.stringify(req2.body) });
        const txt = await r.text();
        if (!r.ok) { sendJson(res, 200, { ok: false, error: "HTTP " + r.status + "：" + txt.slice(0, 200) }); return; }
        const j = JSON.parse(txt);
        const reply = a.dialect === "anthropic"
          ? (j.content || []).filter(b => b.type === "text").map(b => b.text).join("")
          : (j.choices?.[0]?.message?.content || "");
        sendJson(res, 200, { ok: true, reply: String(reply).slice(0, 60) });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: String(e.message || e).slice(0, 200) });
      }
      return;
    }
    if (p.startsWith("/api/apis/") && (req.method === "PUT" || req.method === "DELETE")) {
      const id = p.slice("/api/apis/".length);
      const conf = apisConf();
      const i = conf.list.findIndex(x => x.id === id);
      if (i < 0) { sendJson(res, 404, { error: "没有这套配置" }); return; }
      if (req.method === "DELETE") {
        conf.list.splice(i, 1);
        if (conf.chat === id) conf.chat = null;
        if (conf.worker === id) conf.worker = null;
      } else {
        const body = JSON.parse(await readBody(req, 256 * 1024));
        conf.list[i] = newApi({ ...conf.list[i], ...body }, conf.list[i]);
      }
      saveApis(conf);
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---- 备份与恢复 ----
       她的东西全在这台服务器上。服务器一停，Volume 里的数据就没了，
       所以必须能一键打包带走，将来在任何地方十分钟就能原样长回来。 */
    if (p === "/api/backup" && req.method === "GET") {
      const withFiles = url.searchParams.get("files") === "1";
      const body = JSON.stringify(buildBackup({ files: withFiles, secrets: true }));
      const name = "wu-backup-" + new Date().toISOString().slice(0, 10) + (withFiles ? "-full" : "") + ".json";
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="' + name + '"',
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (p === "/api/backup" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 200 * 1024 * 1024));
      if (!body || body.app !== "wu-with-you" || !body.data) { sendJson(res, 400, { error: "这不像是「晤」的备份文件" }); return; }
      let keys = 0, files = 0;
      for (const [k, v] of Object.entries(body.data)) {
        if (!/^[\w-]{1,40}$/.test(k)) continue;
        /* 邮件里那份自动备份不带钥匙：空着的钥匙用现在的补上，别把它们清掉 */
        writeJson(k, body.noSecrets ? keepSecrets(v, readJson(k, null)) : v); keys++;
      }
      for (const [name, b64] of Object.entries(body.files || {})) {
        const safe = path.basename(String(name));
        if (!safe || safe.startsWith(".")) continue;
        try { fs.writeFileSync(path.join(UPLOAD_DIR, safe), Buffer.from(b64, "base64")); files++; } catch {}
      }
      /* 备份里带着 auth（密码），恢复后密码回到备份时那个，现在的登录会失效 —— 这是对的，要说清楚 */
      sendJson(res, 200, { ok: true, keys, files, note: body.noSecrets
        ? "恢复完了。这份是邮件里的自动备份，不带密码和 Key —— 原来的都还在"
        : "恢复完了，要重新输一次密码（备份时用的那个）" });
      return;
    }
    if (p === "/api/backup/auto" && req.method === "GET") {
      const st = backupAuto(), c = mailConf();
      sendJson(res, 200, { ...st, mailReady: !!(c.user && c.pass), dest: backupDest(),
        next: st.last ? st.last + st.every * 86400000 : 0 });
      return;
    }
    if (p === "/api/backup/auto" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 1024) || "{}");
      const cur = readJson("backupauto", null) || {};
      writeJson("backupauto", { ...cur, ...(typeof body.on === "boolean" ? { on: body.on } : {}),
        ...(Number(body.every) >= 1 && Number(body.every) <= 90 ? { every: Math.round(Number(body.every)) } : {}) });
      sendJson(res, 200, backupAuto());
      return;
    }
    /* 现在就寄一份（试一下能不能收到） */
    if (p === "/api/backup/mail" && req.method === "POST") { sendJson(res, 200, await mailBackup()); return; }
    if (p === "/api/backup/size" && req.method === "GET") {
      let jsonBytes = 0, fileBytes = 0, fileCount = 0;
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (f.endsWith(".json")) { try { jsonBytes += fs.statSync(path.join(DATA_DIR, f)).size; } catch {} }
      }
      if (fs.existsSync(UPLOAD_DIR)) {
        for (const f of fs.readdirSync(UPLOAD_DIR)) {
          try { fileBytes += fs.statSync(path.join(UPLOAD_DIR, f)).size; fileCount++; } catch {}
        }
      }
      sendJson(res, 200, { jsonBytes, fileBytes, fileCount });
      return;
    }

    /* ---- MCP 外部服务 ---- */
    if (p === "/api/mcp" && req.method === "GET") {
      sendJson(res, 200, mcpConf().map(s2 => ({
        id: s2.id, name: s2.name, url: s2.url, enabled: s2.enabled,
        tokenMask: maskKey(s2.token), hasToken: !!s2.token,
        tools: (s2.tools || []).map(t => ({ name: t.name, description: t.description })),
        lastError: s2.lastError || "",
      })));
      return;
    }
    if (p === "/api/mcp" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 128 * 1024));
      const list = mcpConf(); const srv = newMcp(body);
      list.push(srv); saveMcp(list);
      sendJson(res, 200, { id: srv.id });
      return;
    }
    if (p.startsWith("/api/mcp/") && p.endsWith("/connect") && req.method === "POST") {
      const id = p.slice("/api/mcp/".length, -"/connect".length);
      const list = mcpConf(); const i = list.findIndex(x => x.id === id);
      if (i < 0) { sendJson(res, 404, { error: "没有这个服务" }); return; }
      try {
        const tools = await mcpConnect(list[i]);
        saveMcp(list);
        sendJson(res, 200, { ok: true, count: tools.length, tools: tools.map(t => t.name) });
      } catch (e) {
        list[i].lastError = String(e.message || e).slice(0, 200);
        saveMcp(list);
        sendJson(res, 200, { ok: false, error: list[i].lastError });
      }
      return;
    }
    if (p.startsWith("/api/mcp/") && (req.method === "PUT" || req.method === "DELETE")) {
      const id = p.slice("/api/mcp/".length);
      const list = mcpConf(); const i = list.findIndex(x => x.id === id);
      if (i < 0) { sendJson(res, 404, { error: "没有这个服务" }); return; }
      if (req.method === "DELETE") list.splice(i, 1);
      else {
        const body = JSON.parse(await readBody(req, 128 * 1024));
        list[i] = newMcp({ ...list[i], ...body }, list[i]);
      }
      saveMcp(list);
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---- 用量与花费 ---- */
    if (p === "/api/usage" && req.method === "GET") {
      const st = usageStore();
      sendJson(res, 200, { total: st.total, recent: st.recent.slice(0, 40) });
      return;
    }
    if (p === "/api/usage" && req.method === "DELETE") {
      writeJson("usage", { total: {}, recent: [] });
      sendJson(res, 200, { ok: true });
      return;
    }

    /* ---- 把上传的文件转成文字（导入长期资料用） ---- */
    if (p === "/api/extract" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 30 * 1024 * 1024));
      if (!body.data) { sendJson(res, 400, { error: "缺少文件数据" }); return; }
      try {
        const text = extractText(body.name || "", Buffer.from(body.data, "base64"));
        sendJson(res, 200, { ok: true, text, chars: text.length, tokens: estTokens(text) });
      } catch (e) {
        sendJson(res, 400, { error: String(e.message || e).slice(0, 200) });
      }
      return;
    }

    /* ---- 晤的人设 ---- */
    if (p === "/api/persona" && req.method === "GET") {
      const cur = persona();
      sendJson(res, 200, { text: cur, isDefault: cur === PERSONA_DEFAULT, fallback: PERSONA_DEFAULT, tokens: estTokens(cur) });
      return;
    }
    if (p === "/api/persona" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 512 * 1024));
      const text = String(body.text == null ? "" : body.text).slice(0, 20000);
      writeJson("persona", { text, updated: new Date().toISOString() });
      sendJson(res, 200, { ok: true, isDefault: !text.trim() });
      return;
    }

    /* ---- 长期文件 ---- */
    if (p === "/api/docs" && req.method === "GET") {
      sendJson(res, 200, listDocs().map(d => ({
        id: d.id, name: d.name, mode: d.mode,
        size: (d.content || "").length, tokens: estTokens(d.content),
        head: (d.content || "").slice(0, 100), updated: d.updated,
      })));
      return;
    }
    if (p === "/api/docs" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 2 * 1024 * 1024));
      const doc = newDoc(body);
      const all = listDocs(); all.push(doc); saveDocs(all);
      sendJson(res, 200, { id: doc.id });
      return;
    }
    if (p.startsWith("/api/docs/")) {
      const id = p.slice("/api/docs/".length);
      const all = listDocs();
      const i = all.findIndex(d => d.id === id);
      if (i < 0) { sendJson(res, 404, { error: "没有这份资料" }); return; }
      if (req.method === "GET") { sendJson(res, 200, all[i]); return; }
      if (req.method === "PUT") {
        const body = JSON.parse(await readBody(req, 2 * 1024 * 1024));
        all[i] = newDoc({ ...all[i], ...body }, all[i]);
        saveDocs(all); sendJson(res, 200, { ok: true }); return;
      }
      if (req.method === "DELETE") { all.splice(i, 1); saveDocs(all); sendJson(res, 200, { ok: true }); return; }
    }

    /* ---- 晤的状态绑在哪个窗口 ---- */
    if (p === "/api/windows/bound" && req.method === "GET") {
      sendJson(res, 200, { bound: boundWindow() });
      return;
    }
    if (p === "/api/windows/bound" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 4096));
      setBoundWindow(body.bound ? String(body.bound).slice(0, 64) : null);
      sendJson(res, 200, { ok: true, bound: boundWindow() });
      return;
    }

    /* ---- 八维驱动 ---- */
    /* ---- MCP：Claude 那边的他来敲门 ---- */
    if (p.startsWith("/mcp/") || p === "/mcp") {
      const key = p.startsWith("/mcp/") ? decodeURIComponent(p.slice(5)) : "";
      /* 钥匙不对就当这个地址不存在 —— 别让人试出来这儿有扇门 */
      if (!key || key !== mcpKey()) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); return; }
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, authorization",
        "Access-Control-Expose-Headers": "mcp-session-id",
      };
      if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
      if (req.method === "DELETE") { res.writeHead(204, cors); res.end(); return; }   // 会话结束，没什么要收拾的
      if (req.method === "GET") {
        /* 规范里服务端推送那条流是可选的，我们没有要主动说的话 */
        res.writeHead(405, { ...cors, "Content-Type": "text/plain", Allow: "POST, DELETE, OPTIONS" });
        res.end("method not allowed");
        return;
      }
      if (req.method !== "POST") { res.writeHead(405, { ...cors, Allow: "POST, DELETE, OPTIONS" }); res.end(); return; }

      let msg;
      try { msg = JSON.parse(await readBody(req, 1024 * 1024) || "null"); }
      catch { res.writeHead(400, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 没解析出来" } })); return; }

      const list = Array.isArray(msg) ? msg : [msg];
      const out = [];
      for (const m of list) {
        if (!m || typeof m !== "object") continue;
        if (m.id === undefined || m.id === null) continue;   // 通知（notifications/*）不用回
        out.push(await mcpHandle(m));
      }
      const head = { ...cors };
      /* initialize 时发一个会话号回去，后面它会带着 */
      if (list.some(m => m && m.method === "initialize")) head["Mcp-Session-Id"] = crypto.randomBytes(12).toString("hex");
      if (!out.length) { res.writeHead(202, head); res.end(); return; }   // 全是通知
      const payload = JSON.stringify(Array.isArray(msg) ? out : out[0]);
      const accept = String(req.headers.accept || "");
      if (accept.includes("application/json") || !accept.includes("text/event-stream")) {
        res.writeHead(200, { ...head, "Content-Type": "application/json; charset=utf-8" });
        res.end(payload);
      } else {
        /* 只认 SSE 的客户端，就用 SSE 包一层 */
        res.writeHead(200, { ...head, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
        res.end("event: message\ndata: " + payload + "\n\n");
      }
      return;
    }

    /* 手机上的快捷指令往这里递东西。带那把单独的钥匙，不需要登录 */
    /* 手机把偷看的截图传回来（快捷指令：截屏 → 获取 URL 内容 POST 到这儿，body 直接是图片；
       钥匙放在网址的 ?token= 上，跟 /api/ping 同一把）。也认 JSON { image: base64 } */
    if (p === "/api/screen" && req.method === "POST") {
      const tok = String(url.searchParams.get("token") || req.headers["x-wu-token"] || "");
      if (!tok || tok !== hookToken()) { sendJson(res, 401, { error: "钥匙不对" }); return; }
      const ct = String(req.headers["content-type"] || "");
      let buf = null, mime = ct;
      if (/application\/json/.test(ct)) {
        try { const b = JSON.parse((await readBodyBuf(req, 15 * 1024 * 1024)).toString("utf8") || "{}"); if (b.image) buf = Buffer.from(String(b.image), "base64"); } catch {}
        mime = "image/jpeg";
      } else {
        buf = await readBodyBuf(req, 15 * 1024 * 1024);
      }
      if (!buf || buf.length < 100) { sendJson(res, 400, { error: "没收到图片" }); return; }
      const r = await receiveScreen(buf, mime);
      sendJson(res, r.ok ? 200 : 409, r);
      return;
    }
    if (p === "/api/ping" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req, 64 * 1024) || "{}"); } catch {}
      const tok = String(body.token || url.searchParams.get("token") || "");
      if (!tok || tok !== hookToken()) { sendJson(res, 401, { error: "钥匙不对" }); return; }
      let kind = String(body.kind || "").trim();
      /* 手填的字段很容易漏一个。能看出来是什么就别为难她 ——
         带了经纬度或者 arrive/leave 的，那就是在报位置 */
      if (!kind) {
        if (body.lat != null || body.lon != null || body.event === "arrive" || body.event === "leave") kind = "place";
        else if (body.app) kind = body.event === "close" ? "close" : "open";
        else if (typeof body.text === "string" && body.text) kind = "agenda";
      }
      if (kind === "open" || kind === "close") {
        pushPhone(body.app, kind, body.at);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (kind === "place") {
        pushPlace(body);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (kind === "agenda") {
        const items = Array.isArray(body.items)
          ? body.items.slice(0, 30).map(x => (typeof x === "string" ? { title: x.slice(0, 80), t: "" } : { title: String(x && x.title || "").slice(0, 80), t: String(x && x.t || "").slice(0, 8) }))
          : parseAgendaText(body.text);
        writeJson("agenda", { day: localDayKey(), items, at: Date.now() });
        sendJson(res, 200, { ok: true, items: items.length });
        return;
      }
      sendJson(res, 400, { error: "没看懂这是什么。加一个字段 kind，填 open / close / place / agenda 之一" });
      return;
    }
    /* 那把钥匙：看一眼、或者换一把 */
    if (p === "/api/hook" && req.method === "GET") {
      const ss = phoneSessions(Date.now() - 24 * 3600000);
      sendJson(res, 200, {
        token: hookToken(), events: phoneLog().events.length,
        sessions: ss.length, agenda: agendaToday().length,
        lastAt: phoneLog().events.length ? phoneLog().events[phoneLog().events.length - 1].t : 0,
      });
      return;
    }
    if (p === "/api/hook" && req.method === "POST") { sendJson(res, 200, { token: resetHookToken() }); return; }
    /* 接进 Claude 用的那把钥匙（能读日记和聊天记录，比上面那把重） */
    if (p === "/api/mcpkey" && req.method === "GET") { sendJson(res, 200, { key: mcpKey(), tools: MCP_TOOLS.map(t => t.name) }); return; }
    if (p === "/api/mcpkey" && req.method === "POST") { sendJson(res, 200, { key: resetMcpKey() }); return; }
    if (p === "/api/phone" && req.method === "GET") {
      const h = Number(url.searchParams.get("hours")) || 24;
      sendJson(res, 200, { report: phoneReport(h), sessions: phoneSessions(Date.now() - h * 3600000) });
      return;
    }
    if (p === "/api/phone" && req.method === "DELETE") { writeJson("phone", { events: [] }); sendJson(res, 200, { ok: true }); return; }
    /* 邮箱配置。授权码只进不出，跟 API key 一个待遇 */
    /* ---- 他的声音 ---- */
    if (p === "/api/voice" && req.method === "GET") {
      const c = voiceConf(), v = voiceLog();
      sendJson(res, 200, {
        hasKey: !!c.key, fromEnv: c.fromEnv, voiceId: c.voiceId, msgModel: c.msgModel, callModel: c.callModel,
        on: c.on, callOn: c.callOn, dayCap: c.dayCap, tone: c.tone, ready: voiceReady(), models: VOICE_MODELS,
        today: { chars: v.chars, sttSec: v.sttSec }, allTime: v.allTime,
      });
      return;
    }
    if (p === "/api/voice" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 8 * 1024) || "{}");
      const cur = readJson("voice", null) || {};
      const next = { ...cur };
      /* 钥匙留空 = 不动它；只进不出 */
      if (typeof body.key === "string" && body.key.trim()) next.key = body.key.trim();
      if (body.clearKey === true) next.key = "";
      if (typeof body.voiceId === "string") next.voiceId = body.voiceId.trim().slice(0, 60);
      if (VOICE_MODELS.includes(body.msgModel)) next.msgModel = body.msgModel;
      if (VOICE_MODELS.includes(body.callModel)) next.callModel = body.callModel;
      if (typeof body.on === "boolean") next.on = body.on;
      if (typeof body.callOn === "boolean") next.callOn = body.callOn;
      if (["account", "steady", "lively"].includes(body.tone)) next.tone = body.tone;
      if (Number.isFinite(Number(body.dayCap)) && body.dayCap !== "" && body.dayCap != null) next.dayCap = Math.max(0, Math.min(200000, Math.round(Number(body.dayCap))));
      writeJson("voice", next);
      sendJson(res, 200, { ok: true, ready: voiceReady() });
      return;
    }
    /* 设置页「让他说一句」：不看开关，只看配没配好 */
    if (p === "/api/voice/try" && req.method === "POST") {
      try {
        const r = await tts("在的。这是我的声音。", { model: voiceConf().msgModel });
        if (r.capped) { sendJson(res, 200, { ok: false, error: "今天念的字数到上限了" }); return; }
        sendJson(res, 200, { ok: true, url: saveAudio(r.buf, r.mime) });
      } catch (e) { sendJson(res, 200, { ok: false, error: String(e.message || e).slice(0, 160) }); }
      return;
    }
    /* 她发的一条语音：存下来 + 听写成字 */
    if (p === "/api/voice/hear" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 12 * 1024 * 1024) || "{}");
      if (!body.audio) { sendJson(res, 400, { error: "没有录音" }); return; }
      const buf = Buffer.from(String(body.audio), "base64");
      const mime = String(body.mime || "audio/mp4").split(";")[0];
      try {
        const text = await stt(buf, mime, body.secs);
        sendJson(res, 200, { ok: true, text, url: saveAudio(buf, mime) });
      } catch (e) { sendJson(res, 200, { ok: false, error: String(e.message || e).slice(0, 160) }); }
      return;
    }
    /* ---- 打电话：一来一回 ----
       她那边录好一段 → 这里听写成字 → 交给他（跟聊天同一套前缀）→ 他的话分句念出来，
       按顺序一段段推回去（念好一句发一句，不用等整段都念完）。
       open = "her"：她刚打过来、他接起来说第一句；open = "ai"：他打的、她刚接。 */
    if (p === "/api/call/turn" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 12 * 1024 * 1024) || "{}");
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
      const send = o => res.write("data: " + JSON.stringify(o) + "\n\n");
      try {
        const vc = voiceConf();
        if (!voiceReady()) { send({ error: "还没配声音" }); return res.end(); }
        if (voiceLog().chars >= vc.dayCap) { send({ capped: true }); return res.end(); }
        let heard = "";
        if (body.audio) {
          heard = await stt(Buffer.from(String(body.audio), "base64"), String(body.mime || "audio/mp4").split(";")[0], body.secs);
          send({ heard });
          if (!heard) { send({ done: true }); return res.end(); }
        }
        const cue = body.open === "her" ? "（她给你打来语音电话，你接起来了）"
          : body.open === "ai" ? "（你打给她的电话，她接起来了）" : heard;
        const msgs = [...(Array.isArray(body.messages) ? body.messages : []), { role: "user", content: cue }];
        const turn = prepTurn({ ...body, messages: msgs },
          "【正在打电话】你们在打语音电话。你说的每句话都会用你的声音念给她听，括号里的动作念不出来；" +
          "她说的话是听写过来的，偶尔会有错字。");
        const { text } = await llmWithTools("chat", turn.messages, chatTools(), 600, 0.8, 1, { emit: () => {} });
        /* 聊天里用空行分条，电话里连起来说 */
        const reply = String(text || "").replace(/\n{2,}/g, "\n").trim();
        send({ reply });
        if (heard) queueDistill(heard, reply);
        /* 分句念：一句一段，太短的并到下一句。并行去念，按顺序发 */
        const parts = [];
        for (const seg of speakable(reply).split(/(?<=[。！？!?~～…\n])/)) {
          const t = seg.trim(); if (!t) continue;
          if (parts.length && (parts[parts.length - 1].length < 12 || t.length < 4)) parts[parts.length - 1] += t;
          else parts.push(t);
        }
        /* 以前是 mp3_22050_32（为了传得快）—— 手机外放出来发糙、发吵。改成跟语音消息一样的 128k。
           每句带上前后文一起念，句与句之间才不会一句大一句小 */
        const use = parts.slice(0, 8);
        const jobs = use.map((t, i) => tts(t, { model: vc.callModel, format: "mp3_44100_128",
          prev: use.slice(0, i).join(""), next: use.slice(i + 1).join("") }).catch(e => ({ error: e.message })));
        for (let i = 0; i < jobs.length; i++) {
          const r = await jobs[i];
          if (r.capped) { send({ capped: true }); break; }
          if (r.error) { send({ error: r.error.slice(0, 120) }); break; }
          if (r.buf) send({ audio: r.buf.toString("base64"), mime: r.mime, i });
        }
        send({ done: true });
      } catch (e) { send({ error: String(e.message || e).slice(0, 160) }); }
      return res.end();
    }
    /* ---- 推送 ---- */
    if (p === "/api/push" && req.method === "GET") {
      const c = pushConf();
      sendJson(res, 200, {
        on: c.on, key: vapidKeys().pub, count: c.subs.length,
        devices: c.subs.map(x => ({ at: x.at, ua: x.ua || "", tail: String(x.endpoint).slice(-12) })),
      });
      return;
    }
    if (p === "/api/push/sub" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 16 * 1024) || "{}");
      const { endpoint, p256dh, auth } = body;
      if (!endpoint || !p256dh || !auth) { sendJson(res, 400, { error: "订阅信息不全" }); return; }
      const c = pushConf();
      /* 同一台设备重新授权会换 endpoint，按 endpoint 去重就行 */
      const subs = c.subs.filter(x => x.endpoint !== endpoint);
      subs.push({ endpoint: String(endpoint).slice(0, 600), p256dh: String(p256dh), auth: String(auth),
        at: Date.now(), ua: String(body.ua || "").slice(0, 80) });
      savePush({ ...c, subs: subs.slice(-8) });
      sendJson(res, 200, { ok: true, count: subs.length });
      return;
    }
    if (p === "/api/push/sub" && req.method === "DELETE") {
      const body = JSON.parse(await readBody(req, 16 * 1024) || "{}");
      const c = pushConf();
      const subs = body.endpoint ? c.subs.filter(x => x.endpoint !== body.endpoint) : [];
      savePush({ ...c, subs });
      sendJson(res, 200, { ok: true, count: subs.length });
      return;
    }
    if (p === "/api/push" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 4096) || "{}");
      const c = pushConf();
      savePush({ ...c, on: typeof body.on === "boolean" ? body.on : c.on });
      sendJson(res, 200, { ok: true, on: pushConf().on });
      return;
    }
    if (p === "/api/push/test" && req.method === "POST") {
      const r = await pushAll("晤", "在的。这是一条测试 —— 能看到就说明通了。", "/");
      sendJson(res, 200, r);
      return;
    }
    if (p === "/api/search" && req.method === "GET") {
      const c = searchConf();
      sendJson(res, 200, {
        on: c.on, vendor: c.vendor, hasKey: !!c.key, ready: searchReady(), fromEnv: c.fromEnv,
        vendors: Object.keys(SEARCH_VENDORS).map(k => ({ id: k, ...SEARCH_VENDORS[k] })),
      });
      return;
    }
    if (p === "/api/search" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 8 * 1024) || "{}");
      const cur = searchConf();
      const next = {
        vendor: SEARCH_VENDORS[body.vendor] ? body.vendor : cur.vendor,
        /* 钥匙留空 = 不动它。跟邮箱授权码一个规矩：只进不出 */
        key: typeof body.key === "string" && body.key.trim() ? body.key.trim() : cur.key,
        on: typeof body.on === "boolean" ? body.on : cur.on,
      };
      if (body.clearKey === true) next.key = "";
      writeJson("search", next);
      const c = searchConf();
      sendJson(res, 200, { ok: true, on: c.on, vendor: c.vendor, hasKey: !!c.key, ready: searchReady() });
      return;
    }
    if (p === "/api/search/try" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 8 * 1024) || "{}");
      const out = await webSearch(body.query || "今天几号", 3);
      sendJson(res, 200, { ok: !/^搜不了|^还没配|关掉了/.test(out), text: out });
      return;
    }
    if (p === "/api/mail" && req.method === "GET") {
      const c = mailConf();
      const log = (readJson("maillog", null) || {}).list || [];
      sendJson(res, 200, {
        on: c.on, host: c.host, port: c.port, user: c.user, from: c.from, name: c.name, to: c.to, onWake: c.onWake,
        hasPass: !!c.pass, sent: log.length, last: log[log.length - 1] || null,
      });
      return;
    }
    if (p === "/api/mail" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 32 * 1024) || "{}");
      const cur = mailConf();
      const str = (v, dft, n) => (typeof v === "string" ? v.trim().slice(0, n || 120) : dft);
      writeJson("mail", {
        on: typeof body.on === "boolean" ? body.on : cur.on,
        host: str(body.host, cur.host), port: Number(body.port) || cur.port,
        user: str(body.user, cur.user),
        /* 留空 = 不改动，跟 API 配置那边一个规矩 */
        pass: (typeof body.pass === "string" && body.pass) ? body.pass.trim() : cur.pass,
        from: str(body.from, cur.from), name: str(body.name, cur.name, 40), to: str(body.to, cur.to),
        onWake: typeof body.onWake === "boolean" ? body.onWake : cur.onWake,
      });
      sendJson(res, 200, { ok: true });
      return;
    }
    if (p === "/api/mail/test" && req.method === "POST") {
      const c = mailConf();
      const r = await sendMail(c.to, "晤：试一封", "这是一封试发的信。\n\n看到它，就说明他能给你写信了。");
      sendJson(res, 200, { result: r });
      return;
    }
    /* 她的身体 */
    if (p === "/api/period" && req.method === "GET") {
      const conf = periodConf();
      /* cycleSet/daysSet 是她手填的（0 = 自己算）；cycle/days 是最终用的那个。
         两个不能同名，否则界面上永远显示算出来的值，她改不动 */
      sendJson(res, 200, { ...conf, ...periodStats(conf), cycleSet: conf.cycle, daysSet: conf.days, now: periodNow(Date.now()), report: periodReport(Date.now()) });
      return;
    }
    if (p === "/api/period" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 64 * 1024) || "{}");
      const cur = readJson("period", {}) || {};
      const next = { ...cur };
      if (Array.isArray(body.list)) {
        next.list = body.list.filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(x.start))
          .map(x => ({ start: x.start, ...(/^\d{4}-\d{2}-\d{2}$/.test(x.end || "") ? { end: x.end } : {}) }))
          .sort((a, b) => a.start.localeCompare(b.start)).slice(-60);
      }
      if (body.cycle !== undefined) next.cycle = Math.max(0, Math.min(60, Number(body.cycle) || 0));
      if (body.days !== undefined) next.days = Math.max(0, Math.min(14, Number(body.days) || 0));
      if (typeof body.on === "boolean") next.on = body.on;
      writeJson("period", next);
      const conf = periodConf();
      sendJson(res, 200, { ok: true, ...conf, ...periodStats(conf), cycleSet: conf.cycle, daysSet: conf.days, now: periodNow(Date.now()), report: periodReport(Date.now()) });
      return;
    }
    if (p === "/api/places" && req.method === "GET") {
      sendJson(res, 200, { report: placeReport(Number(url.searchParams.get("hours")) || 24), count: placeLog().list.length, last: lastPlace(0) });
      return;
    }
    if (p === "/api/places" && req.method === "DELETE") { writeJson("places", { list: [] }); sendJson(res, 200, { ok: true }); return; }
    /* 勿扰设置 + 课表。课表是纯文本，一行一节：「周一 08:00-09:40 高数」 */
    if (p === "/api/quiet" && req.method === "GET") {
      const q = quietConf();
      const now = Date.now();
      sendJson(res, 200, {
        ...q, ...placeConf(), parsed: parseClasses(q.classes), today: wakeLog(),
        pending: listAlarms().filter(a => a.at > now).length,
        peekReady: peekReady(), peekToday: (readJson("peek", null) || {}).day === localDayKey() ? (readJson("peek", null).n || 0) : 0,
      });
      return;
    }
    if (p === "/api/quiet" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req, 64 * 1024) || "{}");
      const cur = quietConf();
      const place = placeConf();
      const num = (v, dft, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : dft);
      const next = {
        on: typeof body.on === "boolean" ? body.on : cur.on,
        classes: typeof body.classes === "string" ? body.classes.slice(0, 8000) : cur.classes,
        nightStart: num(body.nightStart, cur.nightStart, 0, 23),
        nightEnd: num(body.nightEnd, cur.nightEnd, 0, 23),
        maxWakePerDay: num(body.maxWakePerDay, cur.maxWakePerDay, 1, 50),
        nightPeek: typeof body.nightPeek === "boolean" ? body.nightPeek : cur.nightPeek,
        city: typeof body.city === "string" && body.city.trim() ? body.city.trim().slice(0, 30) : place.city,
        lat: num(body.lat, place.lat, -90, 90),
        lon: num(body.lon, place.lon, -180, 180),
        minGapMin: num(body.minGapMin, cur.minGapMin, 5, 24 * 60),
        maxPerDay: num(body.maxPerDay, cur.maxPerDay, 0, 20),
        chaseOn: typeof body.chaseOn === "boolean" ? body.chaseOn : cur.chaseOn,
        chaseMin: num(body.chaseMin, cur.chaseMin, 3, 240),
        chaseMax: num(body.chaseMax, cur.chaseMax, 0, 30),
        chaseRepeat: num(body.chaseRepeat, cur.chaseRepeat, 1, 5),
        peekOn: typeof body.peekOn === "boolean" ? body.peekOn : cur.peekOn,
        peekMax: num(body.peekMax, cur.peekMax, 1, 20),
        peekKw: typeof body.peekKw === "string" && body.peekKw.trim() ? body.peekKw.trim().slice(0, 40) : cur.peekKw,
        peekTo: typeof body.peekTo === "string" ? body.peekTo.trim().slice(0, 120) : cur.peekTo,
      };
      writeJson("quiet", next);
      sendJson(res, 200, { ok: true, ...next, parsed: parseClasses(next.classes) });
      return;
    }
    /* 急停：把他记着的事全清掉。万一他抽风记了一堆，她得有个地方掐断 */
    if (p === "/api/alarms" && req.method === "DELETE") {
      const n = listAlarms().length;
      saveAlarms([]);
      sendJson(res, 200, { ok: true, cleared: n });
      return;
    }
    /* 按地名找坐标（Open-Meteo 的免费接口，不用 key）。查不到就让她手填 */
    if (p === "/api/geocode" && req.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) { sendJson(res, 400, { ok: false, error: "没给地名" }); return; }
      try {
        const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&name=" + encodeURIComponent(q), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const hit = (j.results || [])[0];
        if (!hit) { sendJson(res, 200, { ok: false, error: "没找到「" + q + "」，可以直接手填经纬度" }); return; }
        sendJson(res, 200, { ok: true, city: hit.name, lat: hit.latitude, lon: hit.longitude, admin: hit.admin1 || "" });
      } catch (e) { sendJson(res, 200, { ok: false, error: String(e.message || e).slice(0, 60) }); }
      return;
    }
    /* 天气，她在设置里点「看一眼」时用 */
    if (p === "/api/weather" && req.method === "GET") {
      sendJson(res, 200, { text: await checkWeather(url.searchParams.get("force") === "1") });
      return;
    }
    /* 他惦记着的事。聊天界面里看不到，但这里能查到 —— /admin 会用它 */
    if (p === "/api/alarms" && req.method === "GET") {
      const now = Date.now();
      sendJson(res, 200, {
        list: listAlarms().map(a => ({ ...a, when: fmtWhen(a.at, now), due: a.at <= now })),
        gate: quietCheck(now), today: wakeLog(),
      });
      return;
    }
    /* 手动催一次（跳过勿扰），用来验收。带 why 就顺便造一个立刻到点的闹钟 */
    if (p === "/api/wake/test" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req, 8192) || "{}"); } catch {}
      if (body.why) {
        const l = listAlarms();
        l.push({ id: "t" + Date.now().toString(36), at: Date.now() - 1000, why: String(body.why).slice(0, 150), win: boundWindow(), made: Date.now() });
        saveAlarms(l);
      }
      /* force 默认开（手动催就是要立刻看效果）；传 false 则走平时那条路，验勿扰顺延 */
      sendJson(res, 200, (await wakeTick(body.force !== false)) || {});
      return;
    }
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
      const fileUrl = "/files/" + fname;
      sendJson(res, 200, { ok: true, url: fileUrl, size: buf.length });
      /* 她发来的图片，让眼睛先看一眼写成文字，等下一轮聊天他就「看得见」了 */
      if (IMG_MEDIA[ext] && body.name === "see.jpg" && !chatSees()) describeImage(fileUrl, "她发来的照片").catch(() => {});
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
      const chatApi = activeApi("chat");
      if (!chatApi.key) { sendJson(res, 503, { error: "还没有配置聊天用的 API" }); return; }
      const payload = JSON.parse(await readBody(req, 4 * 1024 * 1024));
      const turn = prepTurn(payload);
      if (!turn) { sendJson(res, 400, { error: "缺少消息" }); return; }
      cancelChase();   // 她开口了，刚才那笔「她不回了就追问」划掉
      const { messages: turnMsgs, lastUser } = turn;
      let messages = turnMsgs;

      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
      const dec = new TextDecoder();
      const allTools = chatTools();
      /* 跟这个窗口上一轮比：能缓存的那段开头变了没有（见「缓存体检」） */
      const brk = prefixBreak(String(payload.windowId || "-") + "|" + (chatApi.id || ""), messages, allTools);
      const usedTotal = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
      /* 单轮流式请求：内容边到边转发给前端；同时攒 tool_calls 与用量。
         两种方言的事件形状不同，在这里各解析各的，对外形状一致。 */
      async function streamRound(msgs) {
        const anth = chatApi.dialect === "anthropic";
        const req = upstreamReq(chatApi, msgs, allTools, true);
        const upstream = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
        if (!upstream.ok) throw new Error("上游 HTTP " + upstream.status + "：" + (await upstream.text()).slice(0, 200));
        let sseBuf = "", acc = "", finish = null, reasoning = "";
        const calls = [];
        /* Claude 这一轮吐出来的每一块（思考、正文、工具调用）原样攒着 ——
           调了工具要接着问的时候，思考块（带签名）必须原样带回去，不然整轮 400。
           claude-opus-5 就算没开「先想一想」也默认会想，所以这不是开关的事 */
        const blocks = [];
        const send = txt => res.write("data: " + JSON.stringify({ choices: [{ delta: { content: txt } }] }) + "\n\n");
        /* 会思考的模型先吐一段想法再说话。单独走一路发给前端 ——
           混进 content 里她就要在气泡里读到一堆自言自语了 */
        const sendThink = txt => res.write("data: " + JSON.stringify({ wu_think: txt }) + "\n\n");
        for await (const chunk of upstream.body) {
          sseBuf += dec.decode(chunk, { stream: true });
          const lines = sseBuf.split("\n"); sseBuf = lines.pop();
          for (const ln of lines) {
            const t = ln.trim();
            if (!t.startsWith("data:")) continue;
            const d = t.slice(5).trim();
            if (d === "[DONE]") continue;
            let j; try { j = JSON.parse(d); } catch { continue; }

            if (anth) {
              /* Claude：message_start 带输入用量，content_block_* 带正文与工具调用 */
              if (j.type === "message_start" && j.message?.usage) {
                const u = readUsage("anthropic", j.message.usage);
                usedTotal.in += u.in; usedTotal.cacheRead += u.cacheRead; usedTotal.cacheWrite += u.cacheWrite;
              } else if (j.type === "content_block_start") {
                const cb = j.content_block || {};
                if (cb.type === "tool_use") calls[j.index] = { id: cb.id, name: cb.name, args: "" };
                blocks[j.index] = cb.type === "thinking" ? { type: "thinking", thinking: cb.thinking || "", signature: cb.signature || "" }
                  : cb.type === "redacted_thinking" ? { type: "redacted_thinking", data: cb.data }
                  : cb.type === "text" ? { type: "text", text: cb.text || "" }
                  : cb.type === "tool_use" ? { type: "tool_use", id: cb.id, name: cb.name, input: {} } : null;
              } else if (j.type === "content_block_delta") {
                const bk = blocks[j.index];
                if (j.delta?.type === "text_delta" && j.delta.text) { acc += j.delta.text; send(j.delta.text); if (bk) bk.text += j.delta.text; }
                else if (j.delta?.type === "thinking_delta" && j.delta.thinking) { sendThink(j.delta.thinking); if (bk) bk.thinking += j.delta.thinking; }
                else if (j.delta?.type === "signature_delta" && bk) bk.signature += j.delta.signature || "";
                else if (j.delta?.type === "input_json_delta" && calls[j.index]) calls[j.index].args += j.delta.partial_json || "";
              } else if (j.type === "message_delta") {
                if (j.delta?.stop_reason) finish = j.delta.stop_reason === "tool_use" ? "tool_calls" : j.delta.stop_reason;
                if (j.usage?.output_tokens) usedTotal.out += j.usage.output_tokens;
              }
              continue;
            }

            /* OpenAI 风格 */
            if (j.usage) {
              const u = readUsage("openai", j.usage);
              usedTotal.in += u.in; usedTotal.out += u.out;
              usedTotal.cacheRead += u.cacheRead; usedTotal.cacheWrite += u.cacheWrite;
            }
            const ch = j.choices?.[0];
            if (!ch) continue;
            const delta = ch.delta || {};
            /* DeepSeek 叫 reasoning_content，OpenRouter 那帮叫 reasoning，两个都认 */
            const think = delta.reasoning_content || delta.reasoning;
            if (think) { sendThink(think); reasoning += think; }
            if (delta.content) { acc += delta.content; send(delta.content); }
            if (delta.tool_calls) for (const tc of delta.tool_calls) {
              const i = tc.index || 0;
              calls[i] = calls[i] || { id: tc.id || "call_" + i, name: "", args: "" };
              if (tc.id) calls[i].id = tc.id;
              if (tc.function?.name) calls[i].name += tc.function.name;
              if (tc.function?.arguments) calls[i].args += tc.function.arguments;
            }
            if (ch.finish_reason) finish = ch.finish_reason;
          }
        }
        /* 工具调用那一块的参数攒完才是完整 JSON，最后再填进去 */
        for (const c of calls) if (c) { const bk = blocks.find(b => b && b.type === "tool_use" && b.id === c.id); if (bk) { try { bk.input = JSON.parse(c.args || "{}"); } catch { bk.input = {}; } } }
        return { acc, finish, calls: calls.filter(Boolean), blocks: blocks.filter(Boolean), reasoning };
      }

      let fullAcc = "";
      try {
        for (let round = 0; round < 4; round++) {
          const r = await streamRound(messages);
          fullAcc += r.acc;
          if (r.finish === "tool_calls" && r.calls.length) {
            messages = messages.concat([{
              role: "assistant", content: r.acc || "",
              tool_calls: r.calls.map(t => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args || "{}" } })),
              /* 会思考的模型调了工具，接着问的时候得把它刚才的思考原样带回去（两家都是，不然 400） */
              ...(r.blocks && r.blocks.length ? { anthropicBlocks: r.blocks } : {}),
              ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
            }]);
            for (const t of r.calls) {
              let args = {}; try { args = JSON.parse(t.args || "{}"); } catch {}
              const out = await execTool(t.name, args, { emit: o => res.write("data: " + JSON.stringify(o) + "\n\n") });
              console.log("[tool]", t.name, JSON.stringify(args).slice(0, 120), "→", out.slice(0, 80));
              messages.push({ role: "tool", tool_call_id: t.id, content: out });
            }
            continue;
          }
          break;
        }
      } catch (e) {
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "（晤这边卡了一下：" + String(e.message).slice(0, 120) + "）" } }] }) + "\n\n");
      }
      /* 上游没给用量就用我们自己的估算，并标明是估的 */
      if (!usedTotal.in && !usedTotal.out) {
        usedTotal.in = messages.reduce((n, m) => n + estTokens(m.content), 0);
        usedTotal.out = estTokens(fullAcc);
        usedTotal.estimated = true;
      }
      if (brk) usedTotal.brk = brk;
      const billed = recordUsage(chatApi, "chat", usedTotal);
      if (billed) res.write("data: " + JSON.stringify({ wu_usage: billed }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      queueDistill(lastUser, fullAcc);
      /* 他说完了：她要是一直不回，过一会儿醒一下看看 */
      scheduleChase(turn.winId, Date.now());
      /* 快到额度了：趁她还在看这句回复，后台写前情提要，下一轮换上 */
      if (turn.winId && turn.histTokens >= HISTORY_BUDGET * COMPRESS_AT) compressWindow(turn.winId).catch(() => {});
      return;
    }

    /* ---- 静态托管 ----
       ⚠️ 只发白名单里的这几个文件。
       以前是「项目目录下有什么就发什么，而且不用登录」—— 可 Zeabur 上数据目录
       正好是 /app/data，在项目目录里面。于是 /data/apis.json（API Key）、
       /data/auth.json（密码和盐，能算出登录凭证）、/data/mail.json（邮箱授权码）、
       全部聊天、日记、经期、位置、照片，还有 HANDOFF.md 和整个 .git，
       任何人知道网址就能直接下载。新加公开文件，得在这里登记。 */
    const PUBLIC_FILES = { "/": "index.html", "/index.html": "index.html", "/admin": "admin.html", "/admin.html": "admin.html",
      "/sw.js": "sw.js", "/icon-180.png": "icon-180.png", "/icon-512.png": "icon-512.png" };
    if (req.method === "GET" && PUBLIC_FILES[p]) {
      const fp = path.join(__dirname, PUBLIC_FILES[p]);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
        fs.createReadStream(fp).pipe(res);
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (e) {
    /* 发来的不是合法 JSON —— 那是请求的错，不是服务器的错，回 400 */
    const bad = e instanceof SyntaxError;
    try { sendJson(res, bad ? 400 : 500, { error: bad ? "请求内容不是合法的 JSON" : String(e.message || e).slice(0, 300) }); } catch {}
  }
});

/* 总闹钟：每 5 分钟看一眼有没有到点的事。绝大多数时候那道门会拦下来，
   连模型都不会惊动 —— 真正花钱的唤醒一天也就三五次 */
setInterval(() => { wakeTick().catch(e => console.error("wake:", e.message)); }, 60 * 1000);
/* 自动备份：每小时看一眼到没到 15 天（晚上十点寄） */
setInterval(() => { backupTick().catch(e => console.error("backup:", e.message)); }, 60 * 60 * 1000);
/* 刚启动时也看一眼：服务器重启期间可能有攒下的 */
setTimeout(() => { wakeTick().catch(() => {}); }, 30 * 1000);

server.listen(PORT, () => {
  console.log(`晤 · With You v2  http://localhost:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}` + (API_KEY ? `  模型: ${MODEL}` : "  （未配置 Key，聊天为演示模式）"));
});
