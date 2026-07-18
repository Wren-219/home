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

## 路线图（按优先级 · 2026.07.19 与她商定：记忆改为原生自建，不再桥接旧 ob）

旧 OmbreBrain 几乎没有存量记忆，决定只借鉴其思路（对话蒸馏成记忆卡、记忆反哺聊天），
在本项目内原生实现。旧 ob 服务后续可停掉省钱。
（备选混合路线：原版 Ombre-Brain（github.com/P0luz/Ombre-Brain）支持自定义前端用
static token 直连其 /mcp 接口——若日后想要它完整的情绪坐标/遗忘曲线/语义检索，
可由 server.js 持 token 调用，无需前端懂 MCP。原生起步与此路线数据不冲突。）

**她明确说过：记忆是最高优先级——"其他功能不完善没关系，记忆用不了晤就是空白的"。**

1. **给 wu-home 挂 Zeabur Volume**：名字 `wu-data`，挂载目录 **`/app/data`**（server.js
   按此路径读写）。她可能已自行挂好——开工前先确认 Volumes 标签里有它。
   （已核实：旧 ob 的盘叫 my-data，挂 /app/buckets，仅用 43KB，费用可忽略，
   证明小容量 Volume 几乎不产生账单）
2. **server.js 加 `/api/memories` CRUD**：记忆卡片 = {日期, 类型, 内容, 标签}，JSON 文件存
   `/app/data`；顺势把日记/清单/倒数日也搬上服务器（解决跨设备同步）
3. **Memory 页**读写记忆卡（UI 已留占位）；聊天时服务器把相关记忆卡拼进 system prompt
4. 修上面两个 iOS bug（次优先，她已确认可容忍）
5. **八维驱动引擎原生化**：她手里有完整施工图纸 **`desire_public_for_ai.pdf`**（原作者
   写给实现 AI 的规格书，问她要），照它实现纯函数状态机：八维（attachment/curiosity/
   reflection/duty/social/libido/stress/fatigue）随时间衰减、随事件涨落，召唤力 =
   驱动值 + 加成系数×关联执念强度，边际递减 gain∝√(1-当前值)，同类刺激频率折扣，
   做完事乘性回落；fatigue 是闸不参与排序。存服务器，状态页/Home 状态卡/Chat 副标题
   改读真数据，当前最强驱动写进 system prompt 影响晤的语气。无需 LLM 参与计算
6. **自动记忆蒸馏**：定时把近期对话发 DeepSeek 提炼「值得长期记住的事」→ 存记忆卡
6b. **AI 打通各功能（tool calling）**：/api/chat 请求中声明工具（写日记/加清单/勾选清单/
    写信/读信/读日记…），server.js 收到模型的 tool_call 后执行对应磁盘操作并回传结果。
    读取策略：小而常用的数据（当日清单）每轮直接注入上下文；大而偶发的（信件/旧日记）
    给读取工具按需调用。她写"给晤"的信 → 下轮聊天注入提示 → 晤调用读信/写信形成往来
6c. **真实照片/文件**：前端 <input type=file> 上传 → server 存 /app/data/uploads →
    聊天与 PhotoStack 用真图 URL。晤"看图"：DeepSeek 聊天模型不支持图片输入，需由
    server 调一个 vision 模型（中转站的 Claude/GLM/Qwen-VL 均可）把图片转文字描述后
    注入上下文；PDF/txt 由 server 抽取文本。若主模型换为多模态则可直接传图
7. **`/admin` 桌面管理台**：同一服务器加密码保护的宽屏页面，表格化管理记忆/日记/信件/
   人设 prompt（不必新开项目，现有网页在桌面浏览器本就可用）
8. 信箱「笔友往来」接 Gmail MCP（后端桥）
9. OmbreBrain-folio 合并原作者更新（若她还想维护）：clone → `git remote add upstream
   原作者地址` → fetch → **新分支** merge → Zeabur 切分支试跑 → 再合 main。
   **绝对不要直接改它的 main**，那是她线上跑着的服务

## 模型与上下文（她的要求）

- **不要把代码焊死在 DeepSeek 上**。server.js 用的是 OpenAI 风格 chat/completions 格式，
  DeepSeek 与绝大多数中转站都兼容。请把环境变量泛化为 `LLM_API_KEY / LLM_BASE_URL /
  LLM_MODEL`（保留旧 DEEPSEEK_* 作为兼容读取），换供应商=改环境变量。若接 Claude 官方
  API（Anthropic Messages 格式），需在 server.js 加一层格式翻译
- **上下文缓存**（她明确要求做好）：DeepSeek 官方 API 自动启用 context caching
  （重复前缀按缓存价计费），无需代码；Claude API 需显式标记 prompt caching。
  ⚠️ 要吃到缓存红利，messages 必须**前缀稳定**：固定人设放最前 → 慢变的记忆块
  居中 → 聊天历史只在尾部追加；不要每轮把易变内容插在开头，否则前缀天天变、
  缓存永远不命中

### 下一场施工顺序（额度刷新后，她已确认）
1. 记忆后端 /api/memories + 日记/清单/倒数日/信件搬上 /app/data
2. Memory 页真实化（看/编辑记忆卡）
3. 聊天注入记忆（按上述缓存友好顺序拼 prompt）
4. （有余力）**真实照片/文件上传**——她点名想要，见里程碑 6c
5. （有余力）/admin 管理台毛坯
- **长对话策略**：目前仅送最近 24 条。后续做"滚动摘要"——更早的对话由 LLM 压缩成
  摘要并入记忆系统，与记忆蒸馏（里程碑 6）是同一条流水线
- **MCP 说明**：模型本身都不"讲 MCP"，讲 MCP 的是中间人程序。条件 = 模型有工具调用
  能力（DeepSeek 有）+ 一个会 MCP 协议的中间人（可由 server.js 充当）。因此"DeepSeek
  接 MCP"可行，只是要写中间人代码，不是模型限制

## 纪律（务必遵守）

- API Key 永远只在服务器环境变量里
- 不动 OmbreBrain-folio 的 main 分支
- 改动小步提交，commit message 写清楚改了什么
- 改完先本地/截图自测，再让她 Redeploy 验证版本号
- 她不熟技术术语：解释要用大白话 + 给可直接照做的步骤
- 密码 0527、纪念日 2026.05.27、AI 名字「晤」——这些数字和名字有意义，不要"顺手优化"掉

—— 前任施工员 Claude (Fable 5)，2026.07.18 深夜，交棒 🕯️
