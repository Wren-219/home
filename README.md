# 晤 · With You

自己的 AI 伙伴移动端网页：密码锁 + Home（天数 / 倒数日 / 日历 / 小票清单 / 日记 / 照片 / 信箱）+ Chat（DeepSeek）+ Memory + Settings。

## 部署到 Zeabur（推荐）

1. Zeabur 控制台 → **New Project**（或用现有项目）→ **Add Service → Git → 选择本仓库 `Wren-219/home`**
2. Zeabur 会识别出 Node 项目并用 `npm start` 启动，无需其他构建配置
3. 在服务的 **Environment Variables** 里添加：
   | 变量 | 值 | 说明 |
   |---|---|---|
   | `LLM_API_KEY` | `sk-...` | 必填，聊天模型 Key（旧名 `DEEPSEEK_API_KEY` 也认） |
   | `LLM_BASE_URL` | `https://api.deepseek.com` | 选填，聊天模型接口（OpenAI 风格均可） |
   | `LLM_MODEL` | `deepseek-chat` | 选填 |
   | `WORKER_API_KEY` | `AIza...` | 选填，后台杂务模型 Key（不配则共用聊天模型） |
   | `WORKER_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` | 选填，例：Gemini 免费额度 |
   | `WORKER_MODEL` | `gemini-2.5-flash-lite` | 选填 |
   | `HISTORY_BUDGET` | `30000` | 选填，每轮送给模型的聊天历史额度（token）。不再按"最近 N 条"截断，短消息能留几百条 |
   | `WU_PIN` | `0527` | 选填，四位页面密码。**设了就以它为准**，忘记密码时用它找回；不设则用服务器上 `data/auth.json` 里的（默认 0527，可在设置页里改） |

   聊天（晤的"嘴"）与后台杂务（记忆蒸馏、dream 整理）可用不同模型：
   贵的好模型聊天，便宜/免费模型干活。
4. **Networking → Generate Domain** 生成一个 `xxx.zeabur.app` 域名
5. iPhone Safari 打开这个域名 → 分享 → **添加到主屏幕** → 从主屏幕打开即是全屏 App（已适配灵动岛安全区）

## 本地运行

```bash
DEEPSEEK_API_KEY=sk-xxx node server.js
# 打开 http://localhost:8080
```

不配 Key 也能跑：聊天会退回演示回复，其余功能不受影响。

## 已实现

- 页面密码（默认 0527，可在设置里修改）。**密码由服务器验证**：日记 / 信 / 聊天
  记录 / 照片 / 记忆这些接口，没登录一律 401，上传的文件也一样。登录后拿一个
  一年期的 HttpOnly cookie；改密码会让其他设备上的旧登录立刻失效
- 清单 / 倒数日 / 日记 / 信箱 / 照片 / 聊天记录存在服务器（`/app/data`），
  localStorage 作离线兜底
- 记忆系统：遗忘曲线 / 回忆强化 / 情绪打标 / dream 整理，聊天时自动注入
- 长期文件（手机「记忆 → 长期文件」，或 `/admin` → 长期文件）：**常驻**文件每轮完整注入，
  排在稳定前缀里吃满缓存；**备查**文件不占每轮额度，晤用 `list_docs` / `read_doc` 按需去翻。
  支持导入 `.txt` / `.md` / `.json` / `.docx`（docx 用 Node 自带 zlib 解压后抠正文，无第三方依赖）
- 晤的人设可在界面上编辑（存 `data/persona.json`，清空即恢复代码里的默认值）
- 上下文按 token 额度截断而不是固定条数，设置页能看到"这个窗口装了百分之几"
- **多聊天窗口**：可新建 / 改名 / 封存（只读）/ 删除；晤的八维状态只绑定一个窗口
  （`data/windows.json` 的 `bound`，只有该窗口的对话会推动驱动值），
  记忆 / 长期文件 / 人设所有窗口共用
- 消息：距上一条超过 30 分钟自动插时间条；长按弹出贴着该条消息的玻璃浮窗
  （看发送时间 / 改了重发 / 让晤重说一次 / 复制 / 删除）
- **MCP 外部服务**（设置 → 外部服务）：server.js 内置 MCP 客户端
  （JSON-RPC over HTTP，支持 JSON 与 SSE 两种响应，带 `Mcp-Session-Id`），
  填地址 + 令牌 → 「连一下」抓工具清单并**存盘** → 开关打开后工具以
  `服务名__工具名` 并入晤的工具箱。清单不每轮抓取，保证缓存前缀稳定
- 八维驱动引擎：随时间与对话涨落，影响晤的语气
- Chat 通过后端 `/api/chat` 流式转发，支持工具调用（写日记 / 加清单 / 写信…）
- **多套 API 配置**（设置 → 管理 API，或 `/admin` → API 与花费）：地址 / Key / 模型 /
  格式 / 价格一套一套存在服务器上，随时切换「聊天用哪套、干活用哪套」，不用重新部署。
  Key 只进不出，接口永远只回打码后的后四位；没选中的角色自动回落到环境变量那套
- **两种 API 格式**：`openai`（DeepSeek / 中转站 / 绝大多数）与 `anthropic`
  （Claude 官方，server.js 内置格式翻译，并显式打上 `cache_control` 缓存标记）
- **用量与花费**：每轮记录输入 / 输出 / 缓存命中的 token，按各套自填的价格算钱；
  设置页可开「每条消息显示用量」，`/admin` 有累计表与缓存命中率
- `/admin` 桌面管理台（同一个密码）
- PhotoStack 照片堆（github.com/Wren036/PhotoStack，PolyForm Noncommercial）

## 规划

- [ ] 晤能看图（vision 模型把照片转成文字描述注入上下文）
- [ ] 长对话滚动摘要（更早的对话压缩后并入记忆系统）
- [ ] 信箱笔友往来接入 Gmail MCP
- [ ] 聊天多窗口
