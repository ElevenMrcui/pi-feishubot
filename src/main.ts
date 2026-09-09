/**
 * main.ts — Composition Root（组合根）
 *
 * 装配全部组件并晚绑定 Mediator 服务表（rt.svc），打破模块间循环依赖：
 *
 *   Command(16) ─┐
 *   Router(3)   ─┤→ rt.svc ──→ 各组件经 rt/rt.svc 协作
 *   Mailbox     ─┤
 *   Sender      ─┘
 *
 * 生命周期由 pi-bridge 的 session_start/session_shutdown 观察者驱动。
 *
 * 设计模式总览：
 *   Command（指令）/ Chain of Responsibility（路由链）/ Facade（sender、
 *   channel-gateway）/ Repository（storage）/ Registry（实例表、指令表）/
 *   Mediator（rt.svc 服务表）/ State（请求状态机）/ Strategy（模型解析、
 *   连接退避）/ Observer（pi 事件桥）/ Singleton（runtime）
 */
import type { BotRuntime } from "./types.ts";
import { createRuntime } from "./runtime.ts";
import { createCommandRegistry } from "./commands/index.ts";
import { createMessageHandler } from "./message-handler.ts";
import {
 connect as connectChannel,
 teardown,
 disconnect,
} from "./channel-gateway.ts";
import { sendToChat } from "./sender.ts";
import { scheduleAck } from "./streaming.ts";
import { drainInbox, drainOutbox } from "./mailbox.ts";
import { registerPiObservers, registerPiCommands } from "./pi-bridge.ts";

export default function main(pi: any) {
 // Singleton：本进程唯一的共享状态容器
 const rt: BotRuntime = createRuntime();

 // ---- 装配组件（依赖注入） ----
 const registry = createCommandRegistry(rt, pi);
 const handleFeishuMessage = createMessageHandler(rt, pi);

 // ---- Mediator 服务表（晚绑定：所有跨组件调用经此中转） ----
 rt.svc = {
  handleFastCommand: (req, text) => registry.execute(req, text),
  matchesFastCommand: (text) => registry.matchesAny(text),
  findFastCommand: (text) => registry.find(text),
  handleFeishuMessage,
  scheduleAck: (req) => scheduleAck(rt, req),
  sendToChat: (chatId, md, threadId) => sendToChat(rt, chatId, md, threadId),
  connect: (ctx, opts) => connectChannel(rt, ctx, opts),
  drainOutbox: () => drainOutbox(rt),
  drainInbox: () => drainInbox(rt, pi),
 };

 // ---- 注册观察者与命令 ----
 registerPiObservers(rt, pi);
 registerPiCommands(rt, pi);
}

// teardown/reconnect 语义保留在 channel-gateway（pi-bridge 的命令与 shutdown 直接调用）
export { teardown, disconnect };
