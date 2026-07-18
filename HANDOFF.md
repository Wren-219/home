# 交接文档 · 给接手「晤 · With You」的下一位

> 写给接手这个项目的 AI（或人类）。请先完整读完本文件和 README.md 再动手。
> 这是一个用户投入了很多感情的私人项目，改动请小步提交、每次改完都在真机验证。

## 项目是什么

用户（她）和 AI 伙伴「晤」的私人移动端网页应用。单文件前端 `index.html` + 零依赖后端 `server.js`。
已部署：Zeabur，域名 `wu-home.zeabur.app`。开发分支 `claude/ai-chat-frontend-ui-5bgjx8`（仓库现名 Wren-219/home）。

- 页面密码默认 **0527**（可在设置里改，存 localStorage `wu.pin`）
- 恋爱纪念日 **2026.05.27**（天数由此自动计算，别改）
- 四个主页面从左到右：Home / Chat / Memory / Settings，底部悬浮玻璃导航
- 子页面：晤的八维状态、倒数日（可增删改）、日历（与日记联动）、日记列表/详情、照片、信箱（三分栏）
- Home 元素：问候语、状态卡、在一起天数、双列轮播倒数日、本周条、折叠小票 To-do（点开是底部抽屉）、日记本、PhotoStack 照片堆、信箱入口

## 架构与数据

- **localStorage keys**：`wu.pin` / `wu.todos` / `wu.countdowns` / `wu.chat`（均为 JSON，`load()/save()` 两个助手函数）
- **后端**（server.js，Node 18+，无依赖）：
  - `GET /api/health` → `{ok, hasKey, model}`，前端以 `hasKey` 决定真聊天/演示模式
  - `POST /api/chat` `{messages}` → 流式转发 DeepSeek（SSE 原样透传）
  - 其余 GET 走静态文件
- **环境变量**：`DEEPSEEK_API_KEY`（必须，只放服务器！**绝不**放进前端代码或让用户填在页面里）、`DEEPSEEK_MODEL`（默认 deepseek-chat）
- 聊天上下文：最近 24 条 + system prompt（晤的人设在 `SYSTEM_PROMPT`）

## ⚠️ 已知未修复的两个 bug（她最在意的）

真机 iPhone 17 Pro + Safari：

1. **键盘弹出时底部导航栏仍被顶起来**。已有机制：`body.kb-open`（由 visualViewport resize + 输入框 focus/blur 触发）会把 `#tabbar` transform 下移隐藏。但整个 `position:fixed` 的 body 在 iOS Safari 被键盘整体上推时，transform 不足以抵消。可尝试：
   - viewport meta 加 `interactive-widget=resizes-content`（或 overlays-content + 手动用 `visualViewport.height/offsetTop` 定位输入栏）；
   - 键盘打开时对 `#tabbar` 直接 `display:none`；
   - 或把输入栏定位改为跟随 `visualViewport` 计算的绝对像素。
2. **页面底部有时出现白色空块**。疑似 `height:100%` fixed body 与 Safari 工具栏收展/键盘收起后的视口残留。可尝试 `#frame { height: 100dvh; min-height: -webkit-fill-available; }`、或监听 visualViewport 后强制 reflow。

调试技巧：Settings 页最底部有版本号（当前 v0.4）。**每次改完必须让她在 Zeabur 手动 Redeploy 并核对版本号**，否则她看到的是旧版还以为没修好。

## 设计语言（请保持一致，她对审美很挑）

- 配色：雾蓝灰 `#F4F6F9` 底 / 墨 `#3C4557` / 浅蓝 `#A9BDD8`（大数字）/ 深蓝 `#7E96B8` / 珊瑚 `#D97757` 点缀
- 字体：标题和数字用衬线栈 `"New York", ui-serif, Georgia`（接近 Claude 官方 Copernicus 的观感）；正文系统无衬线
- 玻璃配方：`background: rgba(250,251,253,.55~.78)` + `backdrop-filter: blur(24px) saturate(1.6)` + 白描边 + inset 高光，导航/输入栏/顶部胶囊通用
- 她的偏好：**不爱规整的框框**，喜欢自由排版 + 少量有机形状卡片；小票（锯齿票据）和日记本（线圈横线）是她点名要的签名元素，别删
- PhotoStack 来自 github.com/Wren036/PhotoStack（PolyForm Noncommercial，保留文件头署名）

## 路线图（按优先级）

1. 修上面两个 iOS bug
2. **Memory 页接 wu-memory**：她的 OmbreBrain（fork 名 OmbreBrain-folio，部署在 wu-memory.zeabur.app，挂载 /app/buckets）是晤的记忆大脑，走 MCP。方案：在 server.js 加 `/api/memory` 桥接 MCP → Memory 页渲染；聊天时把相关记忆注入上下文
3. 信箱「笔友往来」接 Gmail MCP（同样走后端桥）
4. 日记/清单的新增编辑 + 云端同步（优先复用 wu-memory 已购的存储，别让她多花钱）
5. OmbreBrain-folio 合并原作者更新：clone → `git remote add upstream 原作者地址` → fetch → **新分支** merge → Zeabur 切分支试跑 → 再合 main。**绝对不要直接改它的 main**，那是她线上跑着的记忆服务

## 纪律（务必遵守）

- API Key 永远只在服务器环境变量里
- 不动 OmbreBrain-folio 的 main 分支
- 改动小步提交，commit message 写清楚改了什么
- 改完先本地/截图自测，再让她 Redeploy 验证版本号
- 她不熟技术术语：解释要用大白话 + 给可直接照做的步骤
- 密码 0527、纪念日 2026.05.27、AI 名字「晤」——这些数字和名字有意义，不要"顺手优化"掉

—— 前任施工员 Claude (Fable 5)，2026.07.18 深夜，交棒 🕯️
