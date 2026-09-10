/**
 * mailbox.ts — Mediator 模式的传输层：跨实例信箱
 *
 * 多实例协作的消息总线：
 * - inbox/{pid}/{messageId}.json —— 网关把消息路由到承载目标会话的实例
 * - outbox/{gatewayPid}/*.json —— 工作实例的回复/主动发送委托网关代发
 * - 死实例的信件由网关接管消化（不静默丢弃）
 */
import { readFile, writeFile, mkdir, readdir, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, watch as fsWatch } from "node:fs";
import { INBOX_ROOT } from "./storage.ts";
import type { BotRuntime, FeishuRequest, InstanceInfo } from "./types.ts";
import { listLiveInstances } from "./instances.ts";

export function inboxDir(rt: BotRuntime, pid: number) {
  return join(INBOX_ROOT, String(pid));
}

/** 网关代发信箱：outbox/{gatewayPid}/{ts}-{rand}.json */
export async function delegateSend(
  gatewayPid: number,
  chatId: string,
  md: string,
) {
  const dir = join(INBOX_ROOT, String(gatewayPid), "outbox");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true }).catch(() => {});
  }
  const file = join(
    dir,
    `send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  await writeFile(file, JSON.stringify({ kind: "send", chatId, md }));
}

/** 把飞书消息投递到目标实例的信箱（投递前校验目标存活） */
export async function routeToInstance(
  target: InstanceInfo,
  rt: BotRuntime,
  payload: {
    chatId: string;
    messageId: string;
    senderName: string;
    senderId?: string;
    threadId?: string;
    text: string;
  },
) {
  // 投递前存活校验：目标心跳必须新鲜（防写死信箱导致消息永久丢失）
  const fresh = (await listLiveInstances(rt)).find((x) => x.pid === target.pid);
  if (!fresh) {
    throw new Error(`目标实例 PID ${target.pid} 已下线`);
  }
  const dir = inboxDir(rt, target.pid);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true }).catch(() => {});
  }
  const file = join(dir, `${payload.messageId}.json`);
  await writeFile(
    file,
    JSON.stringify({ ...payload, toPid: target.pid, ts: Date.now() }),
  );
}

/** 处理投递进来的消息：直接注入本实例（本实例就在目标会话里，零切换） */
export async function processInboxItem(rt: BotRuntime, pi: any, file: string) {
  try {
    const raw = await readFile(file, "utf8");
    // 所有权前置：读到内容即删文件 —— 残缺 JSON（毒丸）解析失败也不会无限重试刷屏
    await rm(file).catch(() => {});
    const payload = JSON.parse(raw);
    if (!payload?.messageId || !payload?.chatId || !payload?.text) return;
    if (rt.seenMessages.has(payload.messageId)) return;
    rt.seenMessages.add(payload.messageId);
    setTimeout(() => rt.seenMessages.delete(payload.messageId), 10 * 60 * 1000);

    const req: FeishuRequest = {
      chatId: payload.chatId,
      messageId: payload.messageId,
      senderName: payload.senderName || "用户",
      senderId: payload.senderId,
      threadId: payload.threadId,
      phase: "thinking",
      streamCtrl: null,
      streamBuffer: "",
      streamFlushTimer: null,
      streamAppended: 0,
      ackTimer: null,
      aliveTimer: null,
      lastActivityAt: 0,
      startedAtMs: Date.now(),
      finalized: false,
      progressTimer: null,
        progressSent: 0,
        viaInbox: true,
    };
    // 快捷指令在目标会话的实例上执行（会话级指令语义正确性的关键）
    if (rt.svc.matchesFastCommand(payload.text)) {
      const handled = await rt.svc.handleFastCommand(req, payload.text);
      if (handled) return;
    }
    rt.requests.set(req.messageId, req);
    rt.activeRequest = req;
    rt.stats.received++;
    // worker 即时 ack：注入成功即回执（网关实例走占位卡，worker 无流式 → 文本回执）
    const busy = rt.currentCtx && !rt.currentCtx.isIdle();
    void rt.svc
      .sendToChat(
        req.chatId,
        busy ? "🫥 收到，已排队（当前有任务执行中，完成后处理）…"
             : "🫥 收到，开始处理…",
      )
      .catch(() => {});
    const injectText = `[feishubot] [${req.senderName}] [${req.chatId}] [${req.messageId}]\n${payload.text}`;
    await pi.sendUserMessage([{ type: "text", text: injectText }], {
      deliverAs: "steer",
    });
    rt.svc.scheduleAck(req);
    // 无流式卡片的实例：启动文本进度播报（30s 节流，工具级状态可见）
    const { startProgressNotifier } = await import("./streaming.ts");
    startProgressNotifier(rt, req);
  } catch (e: any) {
    console.error("[feishubot] inbox 处理失败:", e?.message || e);
  }
}
