/**
 * sender.ts — Facade 模式：出站发送唯一出口
 *
 * 屏蔽 Lark SDK 的 reply/send 细节：
 * - 长文自动分段（splitLongMarkdown）
 * - markdown 失败 → 纯文本降级（Strategy）
 * - 发送通道选择：本实例 WS → 仅发送通道（REST 直发，无 WS）→ 委托网关 → 死信
 *   （飞书收/发分离：WS 只决定事件接收，发送只需凭据 + chatId）
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { CONFIG_DIR, loadConfig } from "./storage.ts";
import type { BotRuntime, FeishuRequest } from "./types.ts";
import { markdownToText, splitLongMarkdown } from "./utils.ts";
import { delegateSend } from "./mailbox.ts";
import { electGateway, listLiveInstances } from "./instances.ts";

/**
 * 出站通道解析：本实例 WS 优先；否则懒建仅发送通道（无 WS、REST 直发）。
 * 飞书收/发是两条独立通道 —— 发送无需持有事件 WS，网关代发仅作最后兑底。
 */
async function ensureOutboundChannel(rt: BotRuntime): Promise<any | null> {
  if (rt.channel) return rt.channel;
  if (rt.sendOnlyChannel) return rt.sendOnlyChannel;
  const { createLarkChannel, isSDKAvailable } = await import("./sdk.ts");
  if (!isSDKAvailable()) return null;
  const cfg = await loadConfig();
  if (!cfg) return null;
  try {
    // 仅发送：不 connect（无 WS 事件）、不开启保活；REST 直发已实证可行
    rt.sendOnlyChannel = createLarkChannel({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      transport: "websocket",
      resolveSenderNames: true,
      safety: { dedup: { ttl: 300_000 } },
      loggerLevel: "warn",
    });
  } catch (e: any) {
    console.error("[feishubot] 仅发送通道创建失败:", e?.message || e);
    return null;
  }
  return rt.sendOnlyChannel;
}

/** 普通回复：回复触发消息（引用式），分段 + 降级 */
export async function replyMarkdown(
  rt: BotRuntime,
  req: FeishuRequest,
  md: string,
) {
  const ch = await ensureOutboundChannel(rt);
  if (!ch) {
    // 仅发送通道不可用（无凭据/SDK 缺失）→ 委托网关代发（最后兑底）
    const live = await listLiveInstances(rt);
    const gw = electGateway(live);
    if (gw && gw.pid !== rt.SELF_PID) {
      for (const part of splitLongMarkdown(md)) {
        await delegateSend(gw.pid, req.chatId, part);
      }
    } else {
      console.error("[feishubot] 回复无法送达：无可用通道且无存活网关");
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
      await ch.reply(target, { markdown: part });
    } catch {
      try {
        await ch.reply(target, { text: markdownToText(part) });
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
  const ch = await ensureOutboundChannel(rt);
  if (!ch) {
    // 通道不可用（无凭据/SDK 缺失）→ 委托网关代发（最后兑底）
    const live = await listLiveInstances(rt);
    const gw = electGateway(live);
    if (gw && gw.pid !== rt.SELF_PID) {
      await delegateSend(gw.pid, chatId, md);
      return;
    }
    console.error("[feishubot] send 无法送达：无可用通道且无存活网关");
    return;
  }
  const chunks = splitLongMarkdown(md);
  for (let i = 0; i < chunks.length; i++) {
    const part =
      chunks.length > 1
        ? `**[${i + 1}/${chunks.length}]** ${chunks[i]}`
        : chunks[i];
    try {
      await ch.send(
        chatId,
        { markdown: part },
        threadId ? { replyInThread: true } : undefined,
      );
    } catch {
      try {
        await ch.send(
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
 * 回复出口（agent_end / inbox 兑底路径）：
 * 1. 任意可用通道直发（本实例 WS 或仅发送通道 REST）—— 不依赖网关存活
 * 2. 通道全不可用 → 委托网关代发（网关定位：锁持有者优先，选举回落）
 * 3. 无网关 → 落盘死信，网关上线后可补发
 */
export async function sendReplyOut(rt: BotRuntime, chatId: string, md: string) {
  const ch = await ensureOutboundChannel(rt);
  if (ch) {
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
