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
function persona() {
  const p = readJson("persona", null);
  return (p && typeof p.text === "string" && p.text.trim()) ? p.text : PERSONA_DEFAULT;
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
/* 公开：健康检查（不带细节）与登录本身；页面文件本身不含数据，也放行 */
/* /api/ping 也放行 —— 手机上的快捷指令带不了登录 cookie，它自己验一把单独的钥匙 */
const PUBLIC_PATHS = new Set(["/api/health", "/api/login", "/api/ping"]);
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
  return (a && Array.isArray(a.list)) ? a : { list: [], chat: null, worker: null };
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
  const isW = role === "worker";
  return {
    id: "env-" + role, name: "环境变量（Zeabur）", fromEnv: true,
    base: isW ? WORKER_BASE : API_BASE,
    key: isW ? WORKER_KEY : API_KEY,
    model: isW ? WORKER_MODEL : MODEL,
    dialect: guessDialect(isW ? WORKER_BASE : API_BASE),
    price: { ...PRICE0 },
  };
}
function activeApi(role) {
  const conf = apisConf();
  const hit = conf[role] && conf.list.find(x => x.id === conf[role]);
  if (hit && hit.key && hit.base && hit.model) return hit;
  return envApi(role);
}
function publicApi(a, conf) {
  return {
    id: a.id, name: a.name, base: a.base, model: a.model, dialect: a.dialect,
    think: a.think === true, vision: visionOn(a),
    keyMask: maskKey(a.key), hasKey: !!a.key, price: a.price,
    isChat: conf.chat === a.id, isWorker: conf.worker === a.id,
  };
}

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
   但不能无限多：只留最近 LIVE_IMGS 张是真图，更早的只剩那句「发来了 N 张照片」。
   这条线只在她发新照片时往后挪一次，缓存也就只在那时断一次。 */
const LIVE_IMGS = 12;
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
/* 从最新往回数，只给最近 LIVE_IMGS 张留着真图 */
function liveImages(msgs) {
  let left = LIVE_IMGS;
  const out = msgs.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m.imgs) continue;
    const imgs = cleanImgs(m.imgs);
    const keep = imgs.slice(0, Math.max(0, left));
    left -= keep.length;
    const { imgs: _drop, ...rest } = m;
    out[i] = keep.length ? { ...rest, imgs: keep } : rest;
  }
  return out;
}
/* 一条带图的消息，按这套模型的本事拆成 [{kind:"img", media, data}, {kind:"text", text}] */
function imgParts(m, api) {
  const text = String(m.content == null ? "" : m.content);
  const imgs = (m.imgs || []).map(imgOf).filter(Boolean);
  if (!m.imgs || !m.imgs.length) return null;
  if (!visionOn(api) || !imgs.length) {
    /* 不是嘱托，是事实 —— 免得他假装看见了，张口就夸 */
    return [{ kind: "text", text: text + "（你这边看不到图片内容，只知道她发了）" }];
  }
  return [...imgs.map(x => ({ kind: "img", ...x })), { kind: "text", text }];
}
/* 从最新往回收，收到装不下为止；至少留住最后一条 */
function budgetHistory(all, budget) {
  const out = [];
  let sum = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const t = estTokens(all[i].content) + 4 + (all[i].imgs ? all[i].imgs.length * IMG_TOKENS : 0);
    if (out.length && sum + t > budget) break;
    out.unshift(all[i]);
    sum += t;
  }
  while (out.length > 1 && out[0].role === "assistant") out.shift();  // 别以晤的话开头
  return out;
}

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
function smtpSend(conf, to, subject, body, connectFn) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let sock = null, done = false;
    const finish = (err, ok) => {
      if (done) return;
      done = true;
      try { if (sock) sock.destroy(); } catch {}
      err ? reject(err) : resolve(ok);
    };
    const timer = setTimeout(() => finish(new Error("SMTP 超时（20 秒没说完）")), 20000);
    const mailBody = Buffer.from(String(body || ""), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
    const msg = [
      `From: ${mimeWord(conf.name)} <${conf.from}>`,
      `To: <${to}>`,
      `Subject: ${mimeWord(subject)}`,
      `Date: ${mailDate(Date.now())}`,
      `Message-ID: <${crypto.randomBytes(12).toString("hex")}@${(conf.from.split("@")[1] || "wu.local")}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "", mailBody,
    ].join("\r\n");
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
    sock.on("close", () => { clearTimeout(timer); if (step >= steps.length) finish(null, { ok: true, log: lines }); });
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
function parseAlarmAt(at, now) {
  const s = String(at == null ? "" : at).trim();
  let m = s.match(/^\+?(\d{1,4})\s*(分钟|分钟后|分|min|m)?$/i);
  if (m) return now + Math.min(Number(m[1]), 60 * 24 * 7) * 60000;
  m = s.match(/^(今天|明天|后天)?\s*(\d{1,2})[:：](\d{1,2})$/);
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
  return { ok: true };
}

/* ================= 每轮都变的那两块 =================
   聊天和唤醒共用同一份，摆法一致，缓存前缀才认得出来 */
function memBlockOf(query) {
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
  return "你可以使用工具帮她做事：加清单、勾选清单、写日记、写信、读信、读日记、记住重要的事。" +
    "当她请求，或你自己真心想为她做点什么时就用，不必征求许可；做完在回复里自然带一句即可，不要报流水账。" +
    "想不起某段往事的细节时，用 list_docs 看看有哪些长期资料，再用 read_doc 去翻。" +
    "还有一件只属于你自己的事：用 set_alarm 给自己记个时间点 —— 她说「回家再说」「等会儿告诉你」，" +
    "或者你想过一阵问问她某件事怎么样了，就记下来；到那时你会醒过来，重读一遍对话，再决定要不要找她。" +
    "这是你心里的事，她看不见，也不要在回复里说「我设了个提醒」这类话；事情了结了就用 cancel_alarm 划掉。" +
    "她还让你能看到她手机上的动静（她自己挑的那几个 App）——用 check_phone，但别没事就翻，" +
    "那是关心，不是查岗。想知道她那边下不下雨、冷不冷，用 check_weather；" +
    "想知道她人在哪儿，用 check_place；她身体那几天的情况用 check_period，" +
    "她说「我来了」「结束啦」就用 period_log 替她记一笔。" +
    "她要是配了邮箱，你还能用 send_mail 寄信出去 —— " +
    "她不看手机的时候，一封邮件比一条她看不见的消息管用。" +
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
      out[i].content[out[i].content.length - 1].cache_control = { type: "ephemeral" };
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
        const { wuVolatile, imgs, ...rest } = m;
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
  const calls = api.dialect === "anthropic"
    ? (j.content || []).filter(b => b.type === "tool_use").map(b => ({ id: b.id, name: b.name, args: b.input || {} }))
    : (j.choices?.[0]?.message?.tool_calls || []).map(c => {
        let a = {}; try { a = JSON.parse(c.function.arguments || "{}"); } catch {}
        return { id: c.id, name: c.function.name, args: a };
      });
  return { text, billed, calls, raw: j };
}
/* 非流式的一轮工具循环。唤醒那条路要用：他醒来可以先查一眼再决定说什么。
   ⚠️ tools 必须跟聊天那边**逐字相同**（都来自 chatTools()），而且两边都不设
   tool_choice —— 工具排在请求最前面，改一个字节，后面整条前缀的缓存就没了。 */
async function llmWithTools(role, messages, tools, maxTokens, temperature, maxRounds = 2) {
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
    });
    for (const c of r.calls) {
      let out;
      try { out = await execTool(c.name, c.args); }
      catch (e) { out = "（这个没查成：" + String(e.message || e).slice(0, 80) + "）"; }
      console.log("[wake tool]", c.name, JSON.stringify(c.args), "→", String(out).slice(0, 60).replace(/\n/g, " "));
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
  if (!WORKER_KEY || !userText) return;
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
function chatMessagesOf(win) {
  const out = [];
  for (const m of (win.msgs || [])) {
    if (m.k === "me") out.push({ role: "user", content: String(m.t || "") });
    else if (m.k === "ai") out.push({ role: "assistant", content: String(m.t || "") });
    else if (m.k === "stack") {
      /* 这句必须跟前端 toApiMessages() 拼的一模一样，不然唤醒和聊天的前缀对不上 */
      const n = Array.isArray(m.imgs) ? m.imgs.length : 0;
      const imgs = cleanImgs(Array.isArray(m.see) && m.see.length ? m.see : m.imgs);
      out.push({ role: "user", content: "（发来了" + n + "张照片）", ...(imgs.length ? { imgs } : {}) });
    }
    else if (m.k === "file") out.push({ role: "user", content: "（发来了文件：" + (m.name || "") + "）" });
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
  const history = budgetHistory(liveImages(chatMessagesOf(win)), HISTORY_BUDGET);
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
    "把上面你们的对话重新读一遍，然后决定：这会儿要不要主动跟她说句话？\n\n" +
    "沉默是默认答案。十次里有七八次都该继续等下去 —— 一个每天准时冒出来问「在干嘛呀」的人，" +
    "两个星期后就会被她关掉通知；而一个一周只说两句、但每句都在点上的人，她会一直等着。" +
    "让说话有分量的，恰恰是那些没有说话的时候。\n" +
    "所以：只有当你真的有话想说、而且这个时候说出来正合适，才开口。\n" +
    "要开口，就说你此刻真心想说的那一句，像平常那样说，别解释自己为什么忽然出现，" +
    "更不要提起闹钟、提醒、系统这些东西 —— 在她那边，这只是你忽然想起了她。\n\n" +
    "要查点什么再决定也行（她的手机、位置、天气、上网……），查完再给结论。\n\n" +
    "最后只输出 JSON，别的什么都不要：\n" +
    '{"say": true 或 false, "text": "要说的那句话，不说就留空", "again": 多少分钟后再想一次，不必再想就填 null}';

  const messages = [
    { role: "system", content: persona() },
    { role: "system", content: toolHint() },
    ...(alwaysBlock ? [{ role: "system", content: alwaysBlock }] : []),
    ...history,
    ...(volatileBlock ? [{ role: "system", content: volatileBlock, wuVolatile: true }] : []),
    { role: "user", content: wakePrompt },
  ];

  /* 带上跟聊天那边一模一样的工具：一来前缀对得上、缓存能接着用，
     二来他醒着的时候本来就该能查 —— 查她的手机、天气、上网都行 */
  const { text: raw, billed } = await llmWithTools("chat", messages, chatTools(), 400, 0.8, 2);
  const j = extractJsonObject(raw) || {};
  const text = String(j.text == null ? "" : j.text).trim().slice(0, 600);
  const againNum = Number(j.again);
  const again = Number.isFinite(againNum) && againNum > 0 ? Math.min(Math.round(againNum), 60 * 24 * 3) : null;

  if (j.say === true && text) {
    /* 写回她的聊天记录。这里直接覆盖 chat.json 是有前提的：
       能唤醒就说明她至少 minGapMin 没说话了，手机那边早就自动上锁、
       回来会重新拉一次数据，不会拿旧副本把这条盖掉。 */
    win.msgs.push({ k: "ai", t: text, ts: Date.now(), wake: true });
    writeJson("chat", chat);
    bumpWakeLog(true, billed);
    /* 真推送：锁屏上直接弹。她要是在手机上授过权，这是最快的一条路 */
    pushAll("晤", text.slice(0, 120), "/").catch(e => console.error("push:", e && e.message));
    /* 邮件那条老路留着 —— 推送没授权、或者那台设备的订阅过期了，还有个兜底 */
    const mc = mailConf();
    if (mc.on && mc.onWake && mc.user && mc.pass && mc.to) {
      sendMail(mc.to, "晤：" + text.slice(0, 20) + (text.length > 20 ? "…" : ""), text + "\n\n——\n（他刚才想起你了。回他的话去 wu-home 里说。）")
        .catch(e => console.error("wake mail:", e && e.message));
    }
    /* 话说出去了，惦记就消一点 —— 跟聊天里那一下回落是同一个意思 */
    dr.values.attachment = clamp01(dr.values.attachment * 0.9);
    saveDrives(dr);
    return { ok: true, said: true, text, again };
  }
  /* 没说话也要记一笔 —— 上下文照样读了、钱照样花了 */
  bumpWakeLog(false, billed);
  saveDrives(dr);
  return { ok: true, said: false, again, raw: raw.slice(0, 200) };
}

/* 总闹钟：每 5 分钟看一眼有没有到点的。真正惊动模型的次数由那道门决定 */
let wakeBusy = false;
async function wakeTick(force) {
  if (wakeBusy) return { skipped: "上一次还没结束" };
  wakeBusy = true;
  try {
    const now = Date.now();
    let list = listAlarms();
    /* 服务器停过几天的话，别翻旧账 */
    const stale = list.filter(a => a.at <= now && now - a.at > 12 * 3600000);
    if (stale.length) { list = list.filter(a => !stale.includes(a)); saveAlarms(list); }
    const due = list.filter(a => a.at <= now).sort((a, b) => a.at - b.at);
    if (!due.length) return { skipped: "没有到点的" };

    const gate = force ? { ok: true } : quietCheck(now);
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
    const alarm = due[0];
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
  if (name === "check_now") {
    const now = Date.now();
    const dr = tickDrives(loadDrives(), now);
    return statusBlock(now, driveSnapshot(dr, now), false).replace(/^【现状】/, "");
  }
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
  { type: "function", function: { name: "check_weather", description: "看看她那边的天气（此刻、今天、明天）。聊到出门、穿什么、下不下雨的时候用；也可以在你想提醒她带伞、加衣服的时候主动看一眼",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "check_phone", description: "看看她最近在手机上干什么 —— 打开过哪些 App、什么时候、用了多久、这会儿是不是还开着。她自己挑了几个 App 让你盯着。真的在意她（比如夜深了还没睡、说好要早睡、或者她说在忙却像在刷手机）的时候再看，别每次聊天都翻一遍",
    parameters: { type: "object", properties: { hours: { type: "number", description: "看最近几小时，默认 24，最多 72" } } } } },
  { type: "function", function: { name: "set_alarm", description: "给自己记一个时间点。到那时你会醒过来，重新读一遍你们的对话，再决定要不要开口找她。用在：她说了「回家再说」「等会儿告诉你」这种待会儿要接上的话，或者你想过一阵问问她某件事怎么样了。这是你自己心里的事，她看不见，也不要在回复里提起",
    parameters: { type: "object", properties: { at: { type: "string", description: "什么时候醒：「21:30」「明天 08:00」，或「+180」表示 180 分钟后" }, why: { type: "string", description: "为什么记这个。到时候只有你自己会看到这句话，写清楚些，好让那会儿的你想得起前因后果" } }, required: ["at", "why"] } } },
  { type: "function", function: { name: "cancel_alarm", description: "把自己记下的某件事划掉（她已经说了，或者不必再问了）",
    parameters: { type: "object", properties: { why: { type: "string", description: "那件事的关键词" } }, required: ["why"] } } },
  { type: "function", function: { name: "remember", description: "主动记住一件重要的事（存入记忆卡）",
    parameters: { type: "object", properties: { content: { type: "string", description: "一句话记忆，主语用「她」" }, type: { type: "string", enum: ["事件", "喜好", "约定", "情绪", "日常"] }, importance: { type: "number", description: "1-5" }, tags: { type: "array", items: { type: "string" } } }, required: ["content"] } } },
];
/* 他手里的全部工具。聊天和唤醒必须拿到**逐字相同**的一份 ——
   工具在请求的最前面（tools → system → messages），差一个字节，
   后面整条前缀的缓存就全作废了。所以只有这一个出口。
   没配搜索钥匙的时候把上网那两件撤下来：摆着他会白调一次，
   然后拿一句「还没配」去回她。 */
function chatTools() {
  return (searchReady() ? TOOL_DEFS
    : TOOL_DEFS.filter(t => t.function.name !== "web_search" && t.function.name !== "read_web")
  ).concat(mcpToolDefs());
}
async function execTool(name, args) {
  if (name.includes("__")) return await mcpInvoke(name, args);   // MCP 的工具
  try {
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
    if (name === "check_phone") return phoneReport(args && args.hours);
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
      list.push({ id: "k" + now.toString(36) + Math.random().toString(36).slice(2, 5), at, why, win: boundWindow(), made: now });
      saveAlarms(list);
      return "记下了。到点你会醒一次（她看不见这件事，别在回复里提）";
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
    /* ---- 门卫：数据接口与上传的文件都要先登录 ---- */
    if (guarded(p) && !authed(req)) { sendJson(res, 401, { error: "请先输入密码" }); return; }

    /* ---- 登录：四位密码换一个长期 cookie ---- */
    if (p === "/api/login" && req.method === "POST") {
      const body = JSON.parse(await readBody(req, 4096));
      if (String(body.pin || "") !== currentPin()) { sendJson(res, 403, { error: "密码不对" }); return; }
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

    /* ---- API 配置：key 只进不出，接口永远只回打码后的 ---- */
    if (p === "/api/apis" && req.method === "GET") {
      const conf = apisConf();
      sendJson(res, 200, {
        list: conf.list.map(a => publicApi(a, conf)),
        chat: conf.chat, worker: conf.worker,
        env: { chat: publicApi(envApi("chat"), conf), worker: publicApi(envApi("worker"), conf) },
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
      for (const role of ["chat", "worker"]) {
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
      const a = conf.list.find(x => x.id === id);
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
      const out = { app: "wu-with-you", version: 2, at: new Date().toISOString(), data: {}, files: {} };
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (!f.endsWith(".json")) continue;
        try { out.data[f.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); } catch {}
      }
      if (withFiles && fs.existsSync(UPLOAD_DIR)) {
        for (const f of fs.readdirSync(UPLOAD_DIR)) {
          try {
            const fp = path.join(UPLOAD_DIR, f);
            if (fs.statSync(fp).size > 8 * 1024 * 1024) continue;   // 单个超 8MB 的跳过
            out.files[f] = fs.readFileSync(fp).toString("base64");
          } catch {}
        }
      }
      const body = JSON.stringify(out);
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
        writeJson(k, v); keys++;
      }
      for (const [name, b64] of Object.entries(body.files || {})) {
        const safe = path.basename(String(name));
        if (!safe || safe.startsWith(".")) continue;
        try { fs.writeFileSync(path.join(UPLOAD_DIR, safe), Buffer.from(b64, "base64")); files++; } catch {}
      }
      /* 备份里带着 auth（密码），恢复后密码回到备份时那个，现在的登录会失效 —— 这是对的，要说清楚 */
      sendJson(res, 200, { ok: true, keys, files, note: "恢复完了，要重新输一次密码（备份时用的那个）" });
      return;
    }
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
      const chatApi = activeApi("chat");
      if (!chatApi.key) { sendJson(res, 503, { error: "还没有配置聊天用的 API" }); return; }
      const payload = JSON.parse(await readBody(req, 4 * 1024 * 1024));
      const raw = (payload.messages || []).filter(m => m && (m.role === "user" || m.role === "assistant"))
        .map(m => ({ role: m.role, content: String(m.content == null ? "" : m.content),
          ...(m.role === "user" && cleanImgs(m.imgs).length ? { imgs: cleanImgs(m.imgs) } : {}) }));
      if (!raw.length) { sendJson(res, 400, { error: "缺少消息" }); return; }
      /* 按额度而不是条数截断：短消息能留几百条。图先挑出最近那几张，再算额度 */
      const history = budgetHistory(liveImages(raw), HISTORY_BUDGET);
      const lastUser = [...history].reverse().find(m => m.role === "user")?.content || "";

      /* 驱动引擎：时间流逝对所有窗口都算，但只有绑定窗口里的话会推动他的心情 */
      const now0 = Date.now();
      const bound = boundWindow();
      const winId = payload.windowId ? String(payload.windowId) : null;
      const isBound = !bound || !winId || bound === winId;   // 没设过绑定就一律算数
      const dr = tickDrives(loadDrives(), now0);
      if (isBound) driveEvent(dr, lastUser, now0);
      saveDrives(dr);
      const snap = driveSnapshot(dr, now0);

      const memBlock = memBlockOf(lastUser);
      /* 距上一句超过半小时，才把完整的近况摆给他；连着聊就只报个钟点 */
      const prevTs = Number(payload.prevTs) || 0;
      const status = statusBlock(now0, snap, prevTs > 0 && now0 - prevTs < 2 * 3600000);
      const TOOL_HINT = toolHint();

      /* ---- 缓存友好的摆法 ----
         缓存是「从头逐字比对，一处变了后面全废」。所以：
           稳定的排前面：人设 → 工具说明 → 基本资料（她改一次才变一次）→ 聊天历史（只往后追加）
           每轮都变的排后面：当轮检索到的记忆卡 + 现状，插在她最新那句话之前
         这样能命中缓存的前缀会随着聊天一起变长，聊得越久省得越多。 */
      const alwaysBlock = alwaysDocsBlock();
      const volatileBlock = [memBlock, status].filter(Boolean).join("\n\n");
      let messages = [
        { role: "system", content: persona() },
        { role: "system", content: TOOL_HINT },
        ...(alwaysBlock ? [{ role: "system", content: alwaysBlock }] : []),
        ...history,
      ];
      if (volatileBlock) {
        let at = messages.length;
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { at = i; break; }
        messages.splice(at, 0, { role: "system", content: volatileBlock, wuVolatile: true });
      }

      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
      const dec = new TextDecoder();
      const allTools = chatTools();
      const usedTotal = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
      /* 单轮流式请求：内容边到边转发给前端；同时攒 tool_calls 与用量。
         两种方言的事件形状不同，在这里各解析各的，对外形状一致。 */
      async function streamRound(msgs) {
        const anth = chatApi.dialect === "anthropic";
        const req = upstreamReq(chatApi, msgs, allTools, true);
        const upstream = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
        if (!upstream.ok) throw new Error("上游 HTTP " + upstream.status + "：" + (await upstream.text()).slice(0, 200));
        let sseBuf = "", acc = "", finish = null;
        const calls = [];
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
              } else if (j.type === "content_block_start" && j.content_block?.type === "tool_use") {
                calls[j.index] = { id: j.content_block.id, name: j.content_block.name, args: "" };
              } else if (j.type === "content_block_delta") {
                if (j.delta?.type === "text_delta" && j.delta.text) { acc += j.delta.text; send(j.delta.text); }
                else if (j.delta?.type === "thinking_delta" && j.delta.thinking) sendThink(j.delta.thinking);
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
            if (think) sendThink(think);
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
        return { acc, finish, calls: calls.filter(Boolean) };
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
            }]);
            for (const t of r.calls) {
              let args = {}; try { args = JSON.parse(t.args || "{}"); } catch {}
              const out = await execTool(t.name, args);
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
      const billed = recordUsage(chatApi, "chat", usedTotal);
      if (billed) res.write("data: " + JSON.stringify({ wu_usage: billed }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      queueDistill(lastUser, fullAcc);
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
setInterval(() => { wakeTick().catch(e => console.error("wake:", e.message)); }, 5 * 60 * 1000);
/* 刚启动时也看一眼：服务器重启期间可能有攒下的 */
setTimeout(() => { wakeTick().catch(() => {}); }, 30 * 1000);

server.listen(PORT, () => {
  console.log(`晤 · With You v2  http://localhost:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}` + (API_KEY ? `  模型: ${MODEL}` : "  （未配置 Key，聊天为演示模式）"));
});
