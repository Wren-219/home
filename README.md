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

- 页面密码（默认 0527，可在设置里修改，存于本机）
- 清单 / 倒数日 / 聊天记录本地持久化（localStorage）
- Chat 通过后端 `/api/chat` 流式转发 DeepSeek，Key 只存在服务器
- PhotoStack 照片堆（github.com/Wren036/PhotoStack，PolyForm Noncommercial）

## 规划

- [ ] Memory 页接入 wu-memory（OmbreBrain，经 MCP，由后端桥接）
- [ ] 信箱笔友往来接入 Gmail MCP
- [ ] 日记 / 清单编辑与云端同步
