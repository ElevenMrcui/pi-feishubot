/**
 * pi-feishubot — 飞书官方 Channel SDK 接入扩展（入口薄壳）
 *
 * 完整实现已组件化至 ~/.pi/agent/feishubot/src/（Composition Root: main.ts）：
 *
 *   src/
 *   ├── types.ts           类型契约（BotRuntime / FastCommand / RouteHandler）
 *   ├── runtime.ts         Singleton：共享状态容器
 *   ├── utils.ts           纯函数工具（markdown / 正则 / 会话显示名）
 *   ├── storage.ts         Repository：config / bindings / auth / bai 目录 / settings
 *   ├── instances.ts       Registry：实例注册表 + 心跳 + 网关选举
 *   ├── gateway-lock.ts    磁盘仲裁锁（单写者：飞书 WS 持有权）
 *   ├── mailbox.ts         Mediator 传输层：inbox/outbox 跨实例投递
 *   ├── sender.ts          Facade：出站发送（分段 / 降级 / 委托网关 / 死信）
 *   ├── streaming.ts       State：请求状态机 thinking→streaming→done（打字机卡片）
 *   ├── model-resolver.ts  Strategy：登录目录模型解析
 *   ├── session-control.ts 会话解析 / 切换 / Ghostty 实例生命周期
 *   ├── sdk.ts             @larksuite/channel 加载器
 *   ├── commands/          Command：16 个快捷指令 + Registry
 *   ├── routing.ts         Chain of Responsibility：@标签 → 绑定表 → 本地指令
 *   ├── message-handler.ts 入站编排（守卫 → 路由链 → 注入 pi）
 *   ├── channel-gateway.ts Facade：连接 / 重试退避 / 心跳接管
 *   ├── pi-bridge.ts       Observer：pi 事件桥（含 agent_end 回复配对）+ 命令
 *   └── main.ts            Composition Root（装配 + Mediator 服务表）
 *
 * 旧单文件实现备份：~/.pi/agent/feishubot/legacy-v2-monolith.ts.bak
 */
// @ts-nocheck
import main from "../feishubot/src/main.ts";

export default function (pi: any) {
 return main(pi);
}
