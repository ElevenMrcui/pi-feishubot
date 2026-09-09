# pi-feishubot

飞书官方 [Channel SDK](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/integrate-feishu-channel)（`@larksuite/channel`）接入扩展，让 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 通过飞书聊天远程驱动。

## 特性

- **WebSocket 长连接**：无需公网回调地址；SDK 内置重连 / 心跳 / 去重 / @ 策略 / chat 串行
- **流式打字机卡片**：token 级 `text_delta` → 飞书卡片实时逐字刷新；静默 >15s 原地显示"仍在执行 Ns"
- **零 Token 快捷指令**：`状态` / `停止` / `列出模型` / `切换模型到 X` / `重载` 等秒回，不消耗 LLM
- **多实例网关路由**：多个 pi 会话共存时，磁盘锁仲裁单 WS 网关，消息按**绑定表**路由到承载目标会话的实例；`@标签` 单条临时路由；回复经 outbox 委托网关代发（含死信落盘）
- **登录目录模型解析**：按 auth.json 已登录 provider + bai 账号目录精确过滤，表格展示（✅ 标当前）

## 架构（设计模式）

```text
src/
├── types.ts           类型契约（BotRuntime / FastCommand / RouteHandler）
├── runtime.ts         Singleton：共享状态容器
├── utils.ts           纯函数工具
├── storage.ts         Repository：config / bindings / auth / bai 目录 / settings
├── instances.ts       Registry：实例注册表 + 心跳 + 网关选举
├── gateway-lock.ts    磁盘仲裁锁（单写者：飞书 WS 持有权）
├── mailbox.ts         Mediator：inbox/outbox 跨实例投递
├── sender.ts          Facade：出站发送（分段 / 降级 / 委托网关 / 死信）
├── streaming.ts       State：thinking→streaming→done 打字机状态机
├── model-resolver.ts  Strategy：登录目录模型解析
├── session-control.ts 会话解析 / 切换 / Ghostty 实例生命周期
├── sdk.ts             @larksuite/channel 加载器
├── routing.ts         Chain of Responsibility：@标签 → 绑定表 → 本地指令
├── message-handler.ts 入站编排
├── channel-gateway.ts Facade：连接 / 退避重试 / 心跳接管
├── pi-bridge.ts       Observer：pi 事件桥 + agent_end 回复配对
├── commands/          Command：16 个快捷指令 + Registry
└── main.ts            Composition Root
```

## 安装

```bash
# 1. 依赖
npm install

# 2. 扫码注册飞书应用（凭据自动写入 ~/.pi/agent/feishu-bot/config.json）
node register.mjs

# 3. 扩展入口（软链或复制到 pi 扩展目录）
cp entry/pi-feishubot.ts ~/.pi/agent/extensions/
# 或
ln -s "$(pwd)/entry/pi-feishubot.ts" ~/.pi/agent/extensions/pi-feishubot.ts
```

重启 pi / `/reload` 后自动连接。单聊直接发消息；群聊 `@机器人 + 消息`。

## 快捷指令

| 分类 | 指令 |
| --- | --- |
| 状态 | `状态` `/status` · `停止` `/stop` |
| 模型 | `当前模型` · `列出模型` / `全部模型` · `切换模型到 <名称>` |
| 会话 | `会话` · `切会话 <序号/ID/关键词>` · `绑定会话` / `解绑会话` |
| 实例 | `实例` · `@<标签> <消息>` · `启动实例 <目录> [恢复]` · `恢复会话 <关键词>` · `关闭实例 <pid>` |
| 其他 | `帮助` · `新会话` · `重载` |

## License

MIT
