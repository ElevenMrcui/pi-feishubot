/**
 * message-handler.ts — 入站消息编排器
 *
 * 职责：守卫（连接态/防回环/去重/只@不说话）→ 构建请求状态机 →
 *       执行路由链（Chain of Responsibility）→ 兜底注入 pi（steer）
 */
import type { BotRuntime, FeishuRequest } from "./types.ts";
import { createRouteChain } from "./routing.ts";
import { scheduleAck } from "./streaming.ts";
import { replyMarkdown } from "./sender.ts";

export function createMessageHandler(rt: BotRuntime, pi: any) {
  const chain = createRouteChain(rt);

  return async function handleFeishuMessage(msg: any) {
    if (!rt.connected || !rt.svc) return;

    // bot 消息跳过（防回环）
    if (msg.senderIsBot) return;

    // 去重兜底
    if (rt.seenMessages.has(msg.messageId)) return;
    rt.seenMessages.add(msg.messageId);
    setTimeout(() => rt.seenMessages.delete(msg.messageId), 10 * 60 * 1000);

    const text = (msg.content || "").trim();

    // 只 @ 不说话
    if (!text) {
      if (msg.mentionedBot) {
        await rt.channel
          ?.reply(msg, { text: "👋 我在！直接说需求（发 `帮助` 查看指令）" })
          .catch(() => {});
      }
      return;
    }

    const req: FeishuRequest = {
      chatId: msg.chatId,
      messageId: msg.messageId,
      senderName: msg.senderName || msg.senderId || "用户",
      senderId: msg.senderId,
      threadId: msg.threadId,
      phase: "thinking",
      streamCtrl: null,
      streamBuffer: "",
      streamFlushTimer: null,
      streamAppended: 0,
      ackTimer: null,
      aliveTimer: null,
      lastActivityAt: 0,
      startedAtMs: Date.now(),
      progressTimer: null,
        progressSent: 0,
        finalized: false,
    };

    // 执行路由链（@标签 → 绑定表 → 本地快捷指令），命中即终止
    for (const handler of chain) {
      if (await handler({ msg, req, text, lower: text.toLowerCase() })) return;
    }

    // 兜底：注入 pi（steer 模式）
    rt.stats.received++;
    rt.requests.set(req.messageId, req);
    rt.activeRequest = req;

    const injectText = `[feishubot] [${req.senderName}] [${req.chatId}] [${req.messageId}]\n${text}`;
    try {
      await pi.sendUserMessage([{ type: "text", text: injectText }], {
        deliverAs: "steer",
      });
      scheduleAck(rt, req);
    } catch (e) {
      console.error("[feishubot] 注入 pi 失败:", e);
      rt.requests.delete(req.messageId);
      if (rt.activeRequest === req) rt.activeRequest = null;
      // 注入失败走普通回复兜底
      await replyMarkdown(rt, req, "⚠️ 消息注入失败，请稍后重试。");
    }
  };
}
