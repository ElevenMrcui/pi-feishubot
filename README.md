# pi-feishubot

**pi coding agent 的飞书遥控扩展** — 把 [pi](https://github.com/earendil-works/pi-coding-agent) 装进飞书：在飞书聊天窗口发消息驱动 AI 编码助手，流式查看执行进度，随时切会话、切模型、叫停任务。

基于[飞书官方 Channel SDK](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/integrate-feishu-channel)（`@larksuite/channel`）的 WebSocket 长连接，无需公网服务器、无需 Webhook 回调 —— pi 会话开着，机器人就在线。

## ✨ 特性

- **真·流式打字机**：token 级增量推送到**单张**飞书卡片实时刷新，结束定格全文（不是多条刷屏消息）
- **零 token 快捷指令**：帮助 / 状态 / 停止 / 模型查看与切换 / 会话列表与切换 / 新会话，全部在扩展层秒回，不消耗 LLM token
- **会话管理**：`会话` 列出最近会话（自动提取**中文会话名**），`切会话 <序号>` 无缝切换 pi 历史 session
- **模型管理**：`当前模型` / `列出模型` / `切换模型到 <名称>`，切换即写回默认配置
- **长文安全**：超长回复自动按段落分段（28000 字符/段），卡片失败自动降级纯文本
- **防打扰**：任务执行期间**零中间进度消息**，只有一张流式卡片
- **稳定连接**：WS 保活看门狗、自动重连、消息去重、群聊 @提及门控、发送者真名解析
- **零凭据硬编码**：App 凭据本地存储（`chmod 600`），支持扫码注册或命令行录入

## 📦 安装

```bash
# 方式一：git 安装（推荐）
pi install git:github.com/ElevenMrcui/pi-feishubot@v1.0.0

# 方式二：URL 安装
pi install https://github.com/ElevenMrcui/pi-feishubot
```

pi 会自动拉取仓库并执行 `npm install`（含飞书 SDK）。

### 从源码安装

```bash
git clone https://github.com/ElevenMrcui/pi-feishubot.git
cd pi-feishubot && npm install
pi -e ./extensions/pi-feishubot.ts   # 或复制到 ~/.pi/agent/extensions/
```

## 🔑 配置飞书应用（二选一）

### 方式 A：扫码自动注册（推荐）

```bash
cd ~/.pi/agent/npm/node_modules/pi-feishubot   # pi 包安装位置
npm run register                                # 或 node scripts/register.mjs
```

终端会显示二维码 → 用**飞书 App** 扫码确认 → 自动创建应用、拿到凭据并写入配置。全程无需去开放平台手动操作。

### 方式 B：手动创建应用

1. 前往 [飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用
2. 开通**机器人**能力
3. 添加权限：
   - `im:message`（接收消息）
   - `im:message:send_as_bot`（发送消息）
   - `im:chat.member:readonly`（群成员真名解析，可选）
4. 发布版本后，拿到 `App ID`（`cli_` 开头）和 `App Secret`
5. 在 pi 里执行 `/feishubot-add`，按提示输入凭据

### 配置存储

凭据保存在 `~/.pi/agent/feishu-bot/config.json`，自动 `chmod 600`。**不要提交该文件到任何仓库**（本仓库 `.gitignore` 已排除）。

## 🚀 使用

```bash
pi        # 启动 pi，飞书机器人自动上线
```

看到 `✅ 飞书机器人已连接: Pi` 即成功。

- **单聊**：直接发消息
- **群聊**：需要 @机器人

### 快捷指令表

| 指令 | 说明 |
|------|------|
| `帮助` / `help` | 查看全部指令 |
| `状态` / `status` | 运行状态、模型、上下文占用、正在执行的工具 |
| `停止` / `stop` | 中断当前任务 |
| `当前模型` / `模型` | 查看当前模型 |
| `列出模型` / `models` | 可用模型列表 |
| `切换模型到 <名称>` | 即时切换并保存默认 |
| `会话` / `sessions` | 最近会话列表（中文会话名） |
| `切会话 <序号或名称>` | 切换到指定会话 |
| `新会话` / `/new` | 开启全新会话 |

其余任意自然语言直接发，Pi 执行完毕自动回传结果。

## 🏗 工作原理

```
飞书 WS 长连接 (@larksuite/channel)
   │ message 事件
   ▼
快捷指令拦截（零 token，扩展层直接回）
   │ 未命中
   ▼
steer 注入 pi 会话（[feishubot] 前缀标记来源）
   │ pi 执行（工具调用 / 多轮）
   ▼
text_delta → 单张流式卡片 append（节流 700ms）
   │ agent_end
   ▼
setContent 全文定格 → resolve producer → completeTerminal
```

关键设计：

- **producer 挂起**：SDK 的 `stream()` 在 producer resolve 时即完结卡片，因此 producer 返回手动 Promise 保持 pending，直到任务结束才 resolve —— 这是从"多条卡片刷屏"到"单卡片"的关键
- **请求状态机**：每条飞书消息一个 `FeishuRequest`（thinking → streaming → done），进度/缓冲全部挂在请求上，无全局可变状态污染
- **消息配对**：注入文本携带 `[chatId] [messageId]`，`agent_end` 时按消息配对回传，多通道（钉钉等）共存不串线

## ❓ 常见问题

**机器人一直不在线？**
机器人在线状态 = pi 会话生命周期。pi 没跑，机器人就不在线。

**连接报 `Invalid URL`？**
SDK 的 `domain` 参数只接受完整 URL 或不传。本扩展已处理 —— 如果你二次开发时传了裸字符串 `"feishu"` 就会触发。

**卡片变成多条消息？**
producer 提前 resolve 会导致 SDK rollover 新卡片。本扩展已通过挂起 producer 解决。

**群里机器人不回消息？**
群聊必须 @机器人（`requireMention: true`）。单聊全放行。

**想 7×24 在线？**
用 launchd / systemd 跑一个无头 pi 会话即可（`pi --mode headless` 或 tmux 常驻）。

## 📄 License

MIT
