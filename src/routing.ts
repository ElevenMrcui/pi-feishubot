/**
 * routing.ts — Chain of Responsibility 模式：入站消息路由链
 *
 * 链条（顺序即优先级，命中即终止）：
 * 1. tagRoute    `@标签 消息` 单条临时路由（显式意图，最优先）
 * 2. bindingRoute 绑定表路由：oc_ → 承载目标会话的存活实例（LOCAL_ONLY 指令除外）
 * 3. localCommand 快捷指令本地执行（仅在未路由消息上；会话级指令
 *    如 重载/停止/切换模型 在绑定会话的实例上执行 —— 修复群里 重载
 *    被网关错误就地执行的 bug）
 *
 * 全部未命中 → 返回 false，由 message-handler 注入 pi。
 */
import type { BotRuntime, FastCommand, RouteHandler } from "./types.ts";
import { replyMarkdown } from "./sender.ts";
import { TAG_ROUTE_RE } from "./utils.ts";
import { freshBindings } from "./storage.ts";
import { currentSessionFile, findInstanceBySession } from "./instances.ts";
import { routeToInstance } from "./mailbox.ts";
import { sessionDisplayName } from "./utils.ts";

/** @标签 临时路由 */
function tagRouteHandler(rt: BotRuntime): RouteHandler {
  return async (rc) => {
    const { msg, req, text } = rc;
    const tagMatch = text.match(TAG_ROUTE_RE);
    if (!tagMatch) return false; // 非 @标签消息 → 下一环
    const tag = tagMatch[1];
    const msgText = tagMatch[2].trim();
    if (!msgText) {
      await rt.channel
        ?.reply(msg, { text: `○ @${tag} 后面要有消息内容。` })
        .catch(() => {});
      return true;
    }
    const { findInstanceByTag } = await import("./instances.ts");
    const inst = await findInstanceByTag(rt, tag);
    if (!inst) {
      await rt.channel
        ?.reply(msg, {
          text: `❌ 未找到标签 "${tag}" 对应的运行中实例。发 \`实例\` 查看。`,
        })
        .catch(() => {});
      return true;
    }
    if (inst.pid === rt.SELF_PID) {
      // 就是自己：标记本地落地，跳过后续绑定路由（否则 @网关标签会被错误地
      // 按绑定表再投给其它实例），直接走本地快捷指令/注入
      rc.routeToLocal = true;
      return false;
    }
    // 转发到目标实例（带完整信封，目标实例回复经直发/委托通路回本聊天）
    await routeToInstance(inst, rt, {
      chatId: req.chatId,
      messageId: req.messageId,
      senderName: req.senderName || "用户",
      senderId: msg.senderId || req.senderId,
      threadId: req.threadId,
      text: msgText,
    });
    return true;
  };
}

/** 绑定表路由：发送方级 → 聊天级 → 默认（绑定到其它实例的消息一律投递，除网关级 LOCAL_ONLY 指令） */
function bindingRouteHandler(rt: BotRuntime): RouteHandler {
  return async (rc) => {
    const { msg, req, text } = rc;
    if (rc.routeToLocal) return false; // @标签已指定本实例落地，跳过绑定路由
    const table = await freshBindings();
    rt.chatBindings = table.chats;
    rt.senderBindings = table.senders;
    // 三元绑定查找：发送方级（同群不同人各绑各的）优先于聊天级
    const senderKey = `${req.chatId}|${msg.senderId || req.senderId || ""}`;
    const boundPath = rt.senderBindings[senderKey] || table.chats[req.chatId];
    if (!boundPath || boundPath === currentSessionFile(rt)) return false;

    const target = await findInstanceBySession(rt, boundPath);
    if (!target) {
      const st = await sessionDisplayName({ path: boundPath, id: boundPath });
      await replyMarkdown(
        rt,
        req,
        [
          `❌ 该会话当前没有运行中的 Pi 实例：`,
          `- 会话: **${st}**`,
          `- 先在对应终端启动 pi（可用 \`pi -r ${boundPath.split("/").pop()}\`），实例会自动加入路由。`,
          `- 发 \`实例\` 查看当前运行中的实例。`,
        ].join("\n"),
      );
      return true;
    }
    if (target.pid === rt.SELF_PID) return false; // 绑定到本实例 → 本地处理

    // 网关级查询/绑定类指令留在本地，其余（含快捷指令与普通消息）投递给目标实例
    const cmd: FastCommand | null = rt.svc.findFastCommand(text);
    if (cmd?.localOnly) return false;
    await routeToInstance(target, rt, {
      chatId: req.chatId,
      messageId: req.messageId,
      senderName: req.senderName,
      senderId: msg.senderId || req.senderId,
      threadId: req.threadId,
      text,
    });
    return true; // 投递完成，回复由目标实例经直发/委托通路送达
  };
}

/** 快捷指令本地执行（会话级指令在消息所属会话的实例上生效） */
function localCommandHandler(rt: BotRuntime): RouteHandler {
  return async (rc) => {
    const { req, text } = rc;
    if (!rt.svc.matchesFastCommand(text)) return false;
    const handled = await rt.svc.handleFastCommand(req, text);
    if (!handled) return false;
    // 顺带消费 outbox（降低工作实例委托回复的延迟）
    if (rt.isGateway && rt.channel) await rt.svc.drainOutbox();
    return true;
  };
}

export function createRouteChain(rt: BotRuntime): RouteHandler[] {
  return [
    tagRouteHandler(rt),
    bindingRouteHandler(rt),
    localCommandHandler(rt),
  ];
}
