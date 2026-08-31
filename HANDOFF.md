# 交接文档 · 给接手「晤 · With You」的下一位

> 写给接手这个项目的 AI（或人类）。请先完整读完本文件和 README.md 再动手。
> 这是一个用户投入了很多感情的私人项目，改动请小步提交、每次改完都在真机验证。

## 项目是什么

用户（她）和 AI 伙伴「晤」的私人移动端网页应用。单文件前端 `index.html` + 零依赖后端 `server.js`。
已部署：Zeabur，域名 `wu-home.zeabur.app`。当前开发分支 `claude/read-handoff-md-es8ql0`（仓库 Wren-219/home）。

- 页面密码默认 **0527**（可在设置里改，存 localStorage `wu.pin`）
- 恋爱纪念日 **2026.05.27**（天数由此自动计算，别改）
- 四个主页面从左到右：Home / Chat / Memory / Settings，底部悬浮玻璃导航
- 子页面：晤的八维状态、倒数日（可增删改）、日历（与日记联动）、日记列表/详情、照片、信箱（三分栏）
- Home 元素：问候语、状态卡、在一起天数、双列轮播倒数日、本周条、折叠小票 To-do（点开是底部抽屉）、日记本、PhotoStack 照片堆、信箱入口

## 架构与数据

- **数据现在以服务器为准**（`/api/state`，存 `/app/data`）：`todos` / `countdowns` /
  `diaries` / `letters` / `chat` / `photos`。localStorage 同名 `wu.*` 键只作断网兜底
  （`load()/save()` 两个助手函数，`pushState()` 双写）
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

调试技巧：Settings 页最底部有版本号（当前 v0.9）。**每次改完必须让她在 Zeabur 手动 Redeploy 并核对版本号**，否则她看到的是旧版还以为没修好。

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
2. **server.js 加 `/api/memories` CRUD**——她明确要求做**精致版**（借鉴 ob 的灵魂），
   记忆卡字段：{id, date, type(事件/喜好/约定/情绪/日常), content, tags[],
   importance 1-5, emotion:{valence -1~1, arousal 0~1}, freshness, recalled_count,
   last_recalled}。机制全套：
   - **遗忘曲线**：freshness 随时间衰减，importance 越高衰减越慢；「约定」类不衰减
   - **回忆强化**：被检索命中注入过的卡，freshness 回充、recalled_count+1
   - **检索评分**：关键词/标签匹配 + freshness + importance + 情绪强度加权，取 top N
   - **情绪打标**：蒸馏时由 LLM 顺手给 valence/arousal 打分
   - **dream 整理**：每日把零散卡合并凝练成长期卡（可先做成手动按钮）
   - 所有数值在 Memory 页/未来 /admin 可见——她想"看见系统在想什么"
   （语义向量检索留作后续可选：需 embedding API，先用关键词+评分即可很好用）
   JSON 文件存 `/app/data`；顺势把日记/清单/倒数日也搬上服务器（解决跨设备同步）
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

### 施工进度（2026.07.19 凌晨场）
1. ✅ 记忆后端 /api/memories（含衰减/强化/检索/蒸馏/dream 全套）+ 数据上云 /api/state
2. ✅ Memory 页真实化（看/编辑记忆卡，v0.5）
3. ✅ 聊天注入记忆（缓存友好顺序，已用 mock LLM 端到端验证）
4. ✅ 真实照片/文件上传（/api/upload + /files，前端接系统选择器）
5. ✅ /admin 管理台（记忆表格/清单/倒数日/日记编辑器/驱动滑杆/原始JSON，v0.6）
6. ✅ 八维驱动引擎原生化（缓动/事件涨落/边际递减/频率折扣/回落/疲惫闸/趋势，
   GET·PUT /api/drives，状态注入聊天，前端全接真数据；念头池 fixation 层未做，留作增强）
6.5 ✅ 聊天/杂务双模型分流（v0.7）：聊天走 LLM_*，蒸馏/dream 走 WORKER_*
   （不配则共用）。Gemini 免费额度可作 worker：BASE_URL=
   https://generativelanguage.googleapis.com/v1beta/openai，模型 gemini-2.5-flash-lite。
   注意：Claude 官方 API 是 Anthropic 方言，接聊天需先加格式翻译层（未做）
7. ✅ AI tool calling（v0.8）：七件工具 add_todo/complete_todo/write_diary/
   write_letter/read_letters/read_diaries/remember；/api/chat 流式工具循环
   （边流边攒 tool_calls，最多 4 轮），执行结果回灌模型；前端聊完 refreshShared
   把晤改的清单/日记/信箱回流界面；晤写的信可在信箱拆封阅读（自动标已读）。
   /api/worker-test 可自检干活模型连通性
8. ⬜ iOS 键盘两 bug、Gmail MCP 笔友、看图翻译官（vision）、滚动摘要、fixation 念头池

### 施工进度（2026.08.31 场）
9. ✅ **她也能自己写了（v0.9）**：之前只有晤能写、她只能看，三处假按钮做成真的——
   小票抽屉里直接加待办 / 划掉 / 一键清走已结清；日记「✎ 写一篇」新建、详情页
   可编辑可删除、日历上点空白的一天直接开写；相册新增 `photos` 数据键（存服务器），
   「＋ 添加」上传真照片、聊天里发的照片自动入册、点开是可翻页可删的全屏查看器，
   Home 照片堆改读真照片（相册为空时仍用占位图撑版面）。
   顺手删了设置页「API 接口 / MCP 接口」两张假卡片——那个 API Key 输入框会诱导
   她把钥匙填进网页，与纪律冲突；换成只读的连接状态。状态页/倒数日页过期文案清掉。
10. ✅ **数据加了真锁**：之前 0527 只是前端 localStorage 的挡板，
   `/api/state`、`/api/memories`、`/admin` 全裸奔——知道域名就能读走她全部日记和信。
   现在 `POST /api/login` 用四位密码换一年期 HttpOnly cookie（token = sha256(pin:salt)），
   `/api/*` 与 `/files/*` 未登录一律 401；改密码换新 salt → 其他设备旧登录立刻失效；
   新增环境变量 `WU_PIN`（设了以它为准，是忘记密码时的找回入口）。
   前端把拉数据推迟到解锁之后，401 自动退回锁屏、重输即可继续，数据不丢。
   **服务器是密码的唯一真相**，本机 localStorage 只做断网兜底。

   **离开 5 分钟自动上锁**：手机息屏或切去别的 App 超过 5 分钟，回来要重输密码
   （常量 `AUTO_LOCK_MS` 在 index.html 里，想改时长改这一个数）。短暂切出去不打断；
   锁上只是把界面藏起来，写到一半的日记草稿和数据都不丢。
   注意：她每次「重新打开网页」本来就会走锁屏——通行证 cookie 管的是服务器认不认
   这台设备，跟锁屏是两层，别混起来。

   ⚠️ 部署后第一次打开需要重新输一次 0527（cookie 是新的），这是正常的。
   如果她之前在设置里改过密码，服务器还不认——锁屏会提示"先用 0527 进去，
   再到设置里改一次"，照做即可。

11. ✅ **上下文三件套（v1.0）**
   - **修好了缓存顺序**（每天都在漏的钱）：原来的摆法是 人设 → 工具说明 → 记忆 → 现状 → 历史，
     以为"记忆是慢变的"。但 `retrieveMemories()` 是按当轮问题检索的，**每轮都变**，
     而它排在历史前面 → 缓存前缀每轮从第 3 条就断，整段历史每轮全价重算。
     现在改成：稳定的在前（人设 → 工具说明 → 常驻文件 → 历史），
     每轮变的（记忆卡 + 现状）作为一条 system 消息**插在她最新那句话之前**。
     实测：连续两轮之间逐字相同的前缀从 2 条涨到 5 条，且会随聊天一起变长。
     （注意：往后接 Anthropic 官方 API 时，这条 system 消息正好对应它的
     mid-conversation system message，是同一个设计，不用改结构）
   - **历史按 token 额度而不是条数**：`budgetHistory()` + `HISTORY_BUDGET`（默认 30000）。
     实测 801 条短消息全留下（才装一半），601 条长消息自动收到 105 条且不超额；
     截断后会丢掉开头的 assistant 消息，不以晤的话开头。设置页显示"这个窗口装了 X%"。
   - **长期文件区** `/api/docs`：`{id,name,mode,content}`，mode 为
     `always`（常驻，拼进稳定前缀）或 `ondemand`（备查，给晤 `list_docs`/`read_doc` 两件工具）。
     `/admin` → 「长期文件」里管理，显示每份的字数与 token 估算。
     她的两万字记忆文件按这个拆：核心两三千字设常驻，时间线/大事记设备查。

12. ✅ **人设可编辑 + 手机端文件区 + 文件导入（v1.1）**
   - 人设原来写死在 `const PERSONA` 里，她根本改不了（只能改环境变量）——
     她一直以为常驻文件就是人设。现在 `persona()` 读 `data/persona.json`，
     `GET/PUT /api/persona`，清空即回落到 `PERSONA_DEFAULT`。手机和 /admin 都能改。
   - 手机「记忆」页顶部加了「记忆卡 / 长期文件」切换：能看能改能新建能删，
     人设作为列表第一张卡。大段粘贴仍建议用 /admin。
   - `POST /api/extract` 把上传的文件转成文字：`.txt/.md/.json/.csv` 直接读，
     **`.docx` 用 Node 自带 zlib 手写了个最小 zip 读取器**（找 EOCD → 走中央目录 →
     inflateRaw `word/document.xml` → 剥标签），零依赖。PDF 未做（需要真正的解析器）。

13. ✅ **API 配置 + Anthropic 方言 + 花费统计（v1.2）**
   - `data/apis.json` = `{list:[{id,name,base,key,model,dialect,price}], chat, worker}`。
     `activeApi(role)` 取当前那套，取不到就回落 `envApi(role)`（环境变量永远是兜底，
     界面上配错不会把晤弄哑）。`publicApi()` 只吐 `keyMask`，**key 只进不出**；
     PUT 时 key 留空 = 不改动。`POST /api/apis/:id/test` 打一次最小请求验连通。
   - **Anthropic 方言翻译**（`toAnthropic`）：system 提到顶层、工具转 `input_schema`、
     工具结果转 user 消息里的 `tool_result` 块、流式事件按 `message_start` /
     `content_block_*` / `message_delta` 解析。显式打两个 `cache_control`：
     稳定前缀末尾 + 历史最后一条 assistant（不含每轮变的尾巴，否则白付写入费）。
     ⚠️ 采坑记录：原来靠"还没遇到非 system 消息"判断哪块是稳定前缀，
     **历史只有一条时会把每轮变的那块误判进前缀**，缓存全废。现在用 `wuVolatile`
     标记显式区分，发给 OpenAI 风格前再把这个内部字段摘掉。
   - **用量与花费**：`readUsage()` 归一两种方言的字段（Anthropic 的 input_tokens
     不含缓存部分，要加回去；DeepSeek 用 `prompt_cache_hit_tokens`，OpenAI 风格用
     `prompt_tokens_details.cached_tokens`）。上游没给用量就用 `estTokens` 估算并标注。
     价格随每套配置走（输入/输出/缓存读/缓存写/币种），存 `data/usage.json`。
     流末尾多发一帧 `{wu_usage}` 给前端，聊天气泡下可显示，设置页有累计、
     /admin 有缓存命中率。
   - 手机端能完整管 API 了（子页 `page-apis`）。**之前说"手机上不能填 key"是错的**——
     真正的规矩是 key 不能留在浏览器里，而不是哪个页面能填；现在都存服务器、
     同一把锁，手机上填没有任何额外风险。

14. ✅ **多窗口 + 消息操作（v1.3）**
   - `chat` 状态从「一个消息数组」变成 `{windows:[{id,name,archived,msgs,created}], active}`，
     `migrateChat()` 自动把旧数组迁成第一个窗口（名「日常 · 与晤」），一条都不丢。
     前端 `chatLog` 始终指向当前窗口的 msgs，写回一律走 `saveChat()`。
   - **晤的状态绑一个窗口**：`data/windows.json` 的 `bound`；`/api/chat` 收 `windowId`，
     不是绑定窗口就跳过 `driveEvent`（时间流逝的 tick 仍然照跑）。封存绑定窗口会自动
     把绑定移到下一个活着的窗口。记忆 / 长期文件 / 人设全窗口共用，不受影响。
   - 消息带 `ts` 时间戳；距上一条超 30 分钟插时间条（今天 / 昨天 / 带日期）。
     长按（touch 480ms，桌面右键）弹玻璃面板：看时间 / 改了重发 / 让晤重说 / 复制 / 删除。
     ⚠️ 采坑：流式 AI 气泡是手搓 DOM，不走 `msgNode`，得单独 `bindLongPress`。
     ⚠️ 采坑：`renderDriveUI()` 会早于 `let chatData` 初始化被调用，碰 TDZ 直接抛错
     把整段脚本干掉——用 `var chatReady` 挡住。
   - 旧消息没有 `ts`（那时没记），长按只显示"这条比较早"。

15. ✅ **MCP 客户端 + 长按浮窗 + 时间（v1.4）**
   - **MCP**：`data/mcp.json`，`mcpRpc()` 走 JSON-RPC over HTTP，兼容纯 JSON 和 SSE
     两种响应，握手时接住 `Mcp-Session-Id` 并在后续请求带上。
     `mcpConnect()` = initialize → notifications/initialized → tools/list，
     **抓到的工具清单存盘**；`mcpToolDefs()` 只读存盘的那份并入 `TOOL_DEFS`。
     为什么不每轮去问：工具清单是缓存前缀的第一块，一变整条缓存作废。
     调用按 `服务名__工具名` 路由，`execTool` 改成 async。
   - **关于"工具懒加载省 token"**：实测九个自带工具合计 **854 token**，
     且排在缓存前缀最前面 → 从第二轮起只按 1/10 计。而**改动工具清单会让整条
     前缀作废**：以 14000 token 的前缀算，破一次缓存 ≈ 10 轮的省下量。
     所以懒加载在这里是负收益，**没做**，已跟她讲明数字。
   - **时间**：不做成工具（要多一次往返），直接写进每轮的【现状】——
     年月日 + 星期 + 时:分 + 时段（清晨/上午/…/夜里），零额外成本。
   - **长按浮窗**：从底部抽屉改成贴着那条消息的小玻璃窗（她给了参考图）。
     先量尺寸再定位：优先浮在上方、放不下翻到下方；我说的话右对齐、
     晤说的话左对齐；被选中的气泡加 `.picked` 抬一下。
   - **连不上时的诊断**：`fetchT()` 给 health / state 加 12~15 秒超时，
     失败时明确区分"没回应（多半在重启）"和"连不上"，并给一个「重新连接」按钮。
     以前会永远停在"检查中…"，什么都不说。

16. ✅ **备份 / 搬家 + 两个真 bug（v1.5）**
   - `GET /api/backup?files=0|1` 把 `DATA_DIR` 下所有 `*.json` 打成一个文件下载，
     `files=1` 时把 `uploads/` 里的图按 base64 一起带上（单个超 8MB 的跳过）。
     `POST /api/backup` 恢复；`GET /api/backup/size` 报体积。
     ⚠️ 备份含 `auth`（明文 PIN）与 `apis`（明文 Key）——**恢复后密码回到备份那天的，
     当前登录会失效，必须重新登录**，界面已写明。
   - 🐛 **登录过期会白屏**：`unlockApp()` 排了个「600ms 后把锁屏 display:none」的定时器，
     若这期间 `/api/state` 返回 401 触发 `showLock()`，那个定时器随后把刚弹回来的锁屏
     又藏掉 → app 未 ready + 锁屏不可见 = 白屏。修法：`lockHideTimer` 在 `showLock()` 里清掉。
   - 🐛 **出错自曝**：加了 `window.onerror` / `unhandledrejection` → `noteError()`，
     把错误直接写到设置页的连接栏；`bootData()` 每一步单独 try。
     以前脚本某处抛错会让界面静静停住（比如永远停在"检查中…"），完全看不出原因。

**⚠️ 服务器 2026.09.16 到期，她在考虑不续费。**
   若停用：务必先让她「下载全部」并确认文件到手（几 KB ~ 几十 MB）。
   代码零依赖，任何能跑 Node 18+ 并挂个盘的地方都能起，重新部署 + 恢复约十分钟，
   步骤见 README「备份与搬家」。`xxx.zeabur.app` 子域名释放后不保证能拿回同名。

**下一步（与她商定的顺序）**：④ 长对话滚动摘要（做完一个窗口才真的能一直聊下去）
→ ③ 晤能看图（vision 翻译官）
（顺带把聊天多窗口做成真的）。iOS 键盘两 bug 她已确认可以往后放。

**她那张需求单里还没做的**（2026.08.31 她列的）：
   前端选 API（要做成 /admin 里管理、key 存服务器，**绝不能让她在网页上填 key**）、
   AI 消息重新生成、晤能查时刻、倒数日只在多于一页时才轮播（现在 1-2 个也每 5.6 秒
   重画一次导致闪烁）、消息时间分隔与长按编辑重发（**注意：现有 chatLog 没存时间戳，
   `t` 字段是文本，以前的消息补不出时间**）、token 用量与花费显示（需要
   `stream_options:{include_usage:true}` + 一张手填的价格表）、多窗口（改 chat 数据结构，
   越早做越省事）、a 社 API 格式转换、MCP 管理面板 + Gmail。

**部署提醒**：她需要①确认 wu-home 挂了 Volume（wu-data → /app/data）
②Zeabur Redeploy ③Settings 页看到当前版本号才算生效。蒸馏与 dream 需要
LLM Key 生效（沿用 DEEPSEEK_API_KEY 即可，新名 LLM_API_KEY 也认）。
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
