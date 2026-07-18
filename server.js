/*
 * 晤 · With You — 最小后端
 * 职责：1) 托管前端页面  2) /api/chat 把聊天转发给 DeepSeek（流式）
 * 零依赖，Node 18+ 直接运行：node server.js
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY   必填，DeepSeek 官方 API Key（sk-...）
 *   DEEPSEEK_MODEL     选填，默认 deepseek-chat
 *   DEEPSEEK_BASE_URL  选填，默认 https://api.deepseek.com
 *   PORT               选填，默认 8080（Zeabur 会自动注入）
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const API_BASE = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  /* 健康检查：前端用它判断是否进入真聊天模式 */
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, hasKey: !!API_KEY, model: MODEL });
    return;
  }

  /* 聊天转发：Key 只存在服务器，永远不下发到浏览器 */
  if (req.method === "POST" && url.pathname === "/api/chat") {
    if (!API_KEY) { sendJson(res, 503, { error: "服务器未配置 DEEPSEEK_API_KEY" }); return; }
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 512 * 1024) { sendJson(res, 413, { error: "请求过大" }); return; }
    }
    let payload;
    try { payload = JSON.parse(body); } catch { sendJson(res, 400, { error: "请求不是合法 JSON" }); return; }
    if (!Array.isArray(payload.messages) || !payload.messages.length) {
      sendJson(res, 400, { error: "缺少 messages" }); return;
    }
    try {
      const upstream = await fetch(API_BASE + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: payload.messages,
          stream: true,
          temperature: 0.8,
          max_tokens: 1024,
        }),
      });
      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 500);
        sendJson(res, upstream.status, { error: "DeepSeek 返回错误", detail });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (e) {
      sendJson(res, 502, { error: "转发 DeepSeek 失败", detail: String(e).slice(0, 300) });
    }
    return;
  }

  /* 静态托管：/ → index.html，其余按文件名取 */
  if (req.method === "GET") {
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const fp = path.join(__dirname, path.normalize(name));
    if (fp.startsWith(__dirname) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      fs.createReadStream(fp).pipe(res);
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`晤 · With You 已启动  http://localhost:${PORT}` + (API_KEY ? "（DeepSeek 已配置）" : "（未配置 Key，聊天为演示模式）"));
});
