/**
 * sender.ts — Facade 模式：出站发送唯一出口
 *
 * 屏蔽 Lark SDK 的 reply/send 细节：
 * - 长文自动分段（splitLongMarkdown）
 * - markdown 失败 → 纯文本降级（Strategy）
 * - 工作实例（无 WS）→ 委托网关代发（mailbox.delegateSend）
 * - 无 WS 无网关 → 落盘死信（不静默丢弃）
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { CONFIG_DIR } from "./storage.ts";
import type { BotRuntime, FeishuRequest } from "./types.ts";
import { markdownToText, splitLongMarkdown } from "./utils.ts";
import { delegateSend } from "./mailbox.ts";
import { electGateway, listLiveInstances } from "./instances.ts";

/** 普通回复：优先流式目标之外的原消息回复（引用式），分段 + 降级 */
export async function replyMarkdown(
  rt: BotRuntime,
  req: FeishuRequest,
  md: string,
) {
  if (!rt.channel) {
    // 工作实例（无 WS）：委托网关代发本聊天回复（修复多实例路由无回复）
    const live = await listLiveInstances(rt);
    const gw = electGateway(live);
    if (gw && gw.pid !== rt.SELF_PID) {
      for (const part of splitLongMarkdown(md)) {
        await delegateSend(gw.pid, req.chatId, part);
      }
    } else {
      console.error("[feishubot] 回复无法送达：无 WS 且无存活网关");
    }
    return;
  }
  const chunks = splitLongMarkdown(md);
  const target = {
    chatId: req.chatId,
    messageId: req.messageId,
    threadId: req.threadId,
  };
  for (let i = 0; i < chunks.length; i++) {
    const part =
      chunks.length > 1
        ? `**[${i + 1}/${chunks.length}]** ${chunks[i]}`
        : chunks[i];
    try {
      await rt.channel.reply(target, { markdown: part });
    } catch {
      try {
        await rt.channel.reply(target, { text: markdownToText(part) });
      } catch (e: any) {
        console.error(
          "[feishubot] reply failed:",
          e?.code || "",
          e?.message || e,
        );
      }
    }
  }
}

/** 主动发送到聊天（非引用式） */
export async function sendToChat(
  rt: BotRuntime,
  chatId: string,
  md: string,
  threadId?: string,
) {
  if (!rt.channel) return;
  const chunks = splitLongMarkdown(md);
  for (let i = 0; i < chunks.length; i++) {
    const part =
      chunks.length > 1
        ? `**[${i + 1}/${chunks.length}]** ${chunks[i]}`
        : chunks[i];
    try {
      await rt.channel.send(
        chatId,
        { markdown: part },
        threadId ? { replyInThread: true } : undefined,
      );
    } catch {
      try {
        await rt.channel.send(
          chatId,
          { text: markdownToText(part) },
          threadId ? { replyInThread: true } : undefined,
        );
      } catch (e: any) {
        console.error(
          "[feishubot] send failed:",
          e?.code || "",
          e?.message || e,
        );
      }
    }
  }
}

/**
 * 回复出口：本实例有 WS 就自己发；否则委托网关代发（跨实例回复的救命通路）；
 * 无 WS 无网关 → 落盘死信，网关上线后可补发。
 *
 * 网关定位：优先读网关锁（锁持有者 = WS 持有者，唯一真相源），
 * 锁缺失时才回落按 startedAt 选举（老网关死亡、新实例抢锁后两者可能不一致）。
 */
export async function sendReplyOut(rt: BotRuntime, chatId: string, md: string) {
  if (rt.channel) {
    await sendToChat(rt, chatId, md);
    return;
  }
  const { readGatewayLock } = await import("./gateway-lock.ts");
  const lock = await readGatewayLock();
  let gwPid = lock && lock.pid !== rt.SELF_PID ? lock.pid : 0;
  if (!gwPid) {
    const live = await listLiveInstances(rt);
    const gw = electGateway(live);
    gwPid = gw && gw.pid !== rt.SELF_PID ? gw.pid : 0;
  }
  if (gwPid) {
    await delegateSend(gwPid, chatId, md);
    return;
  }
  const deadDir = join(CONFIG_DIR, "dead-letters");
  if (!existsSync(deadDir)) {
    await mkdir(deadDir, { recursive: true }).catch(() => {});
  }
  await writeFile(
    join(deadDir, `reply-${Date.now()}.json`),
    JSON.stringify({ chatId, md }),
  ).catch(() => {});
  console.error(
    "[feishubot] 回复无法送达，已落盘 dead-letters（" + chatId + "）",
  );
}
