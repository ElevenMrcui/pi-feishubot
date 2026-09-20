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
import { sendImageToChat, findBoundChatId } from "./image.ts";
// @ts-ignore —— typebox 由 pi 宿主提供（jiti 从 pi 的 node_modules 解析），本包内无需依赖
import { Type } from "typebox";

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

 // ---- 自定义工具：send_image（LLM 可直接调用，v2.5.0）----
 // 目标聊天优先级：显式 chatId > 反查绑定到本实例当前会话的聊天
 pi.registerTool?.({
  name: "send_image",
  label: "发送图片到飞书",
  description:
    "把本地图片文件（png/jpg/gif/webp 等，≤10MB）发送到飞书聊天。" +
    "不传 chatId 时发送到「绑定到当前会话」的聊天；若当前会话未绑定任何聊天会报错，" +
    "提示用户在飞书里发 `绑定会话 <关键词>`，或从 `状态`/绑定表中拿 chatId 显式传入。",
  parameters: Type.Object({
   path: Type.String({ description: "本地图片绝对路径" }),
   chatId: Type.Optional(
    Type.String({ description: "可选：目标飞书聊天 ID（oc_ 开头）" }),
   ),
  }),
  async execute(
   toolCallId: string,
   params: { path: string; chatId?: string },
   _signal: any,
   _onUpdate: any,
   _ctx: any,
  ) {
   void toolCallId; void _signal; void _onUpdate; void _ctx;
   try {
    let p = (params?.path || "").trim();
    if (p.startsWith("~")) p = p.replace(/^~(?=$|\/)/, process.env.HOME || "");
    const chatId = (params?.chatId || "").trim() || findBoundChatId(rt);
    if (!chatId) {
     return {
      content: [
       {
        type: "text",
        text: "❌ 未找到目标聊天：当前会话没有绑定任何飞书聊天。请在飞书聊天里发 `绑定会话 <关键词>`，或显式传入 chatId（oc_ 开头）。",
       },
      ],
      details: {},
     };
    }
    const messageId = await sendImageToChat(rt, chatId, p);
    return {
     content: [
      {
       type: "text",
       text: `✅ 图片已发送到 ${chatId}${messageId ? `（message_id: ${messageId}）` : ""}`,
      },
     ],
     details: { chatId, messageId },
    };
   } catch (e: any) {
    return {
     content: [{ type: "text", text: `❌ 图片发送失败: ${e?.message || e}` }],
     details: {},
    };
   }
  },
 });
}

// teardown/reconnect 语义保留在 channel-gateway（pi-bridge 的命令与 shutdown 直接调用）
export { teardown, disconnect };
