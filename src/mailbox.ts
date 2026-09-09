/**
 * mailbox.ts — Mediator 模式的传输层：跨实例信箱
 *
 * 多实例协作的消息总线：
 * - inbox/{pid}/{messageId}.json —— 网关把消息路由到承载目标会话的实例
 * - outbox/{gatewayPid}/*.json —— 工作实例的回复/主动发送委托网关代发
 * - 死实例的信件由网关接管消化（不静默丢弃）
 */
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
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
    const payload = JSON.parse(await readFile(file, "utf8"));
    await rm(file).catch(() => {});
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
      viaInbox: true,
    };
    // 快捷指令在目标会话的实例上执行（会话级指令语义正确性的关键）
    if (rt.svc.matchesFastCommand(payload.text)) {
      const handled = await rt.svc.handleFastCommand(req, payload.text);
      if (handled) return;
    }
    rt.requests.set(req.messageId, req);
    rt.activeRequest = req;
    const injectText = `[feishubot] [${req.senderName}] [${req.chatId}] [${req.messageId}]\n${payload.text}`;
    await pi.sendUserMessage([{ type: "text", text: injectText }], {
      deliverAs: "steer",
    });
    rt.svc.scheduleAck(req);
  } catch (e: any) {
    console.error("[feishubot] inbox 处理失败:", e?.message || e);
  }
}

export async function drainInbox(rt: BotRuntime, pi: any) {
  if (rt.draining) return;
  rt.draining = true;
  try {
    // 死信转移：其它实例的信箱若属已死进程 → 存活实例接管消化
    // （仅网关执行，避免多实例重复转移）
    if (rt.isGateway && rt.channel) {
      try {
        const live = await listLiveInstances(rt);
        const livePids = new Set(live.map((x) => x.pid));
        if (existsSync(INBOX_ROOT)) {
          for (const d of await readdir(INBOX_ROOT)) {
            const pid = parseInt(d, 10);
            if (!livePids.has(pid) && pid !== rt.SELF_PID) {
              const deadDir = inboxDir(rt, pid);
              const files = (await readdir(deadDir)).filter((f) =>
                f.endsWith(".json"),
              );
              if (files.length) {
                console.log(
                  `[feishubot] 接管已死实例 PID ${pid} 的 ${files.length} 条信件`,
                );
                for (const f of files) {
                  await rm(inboxDir(rt, pid) + "/" + f).catch(() => {});
                  await processInboxItem(
                    rt,
                    pi,
                    inboxDir(rt, pid) + "/" + f,
                  ).catch(() => {});
                }
              }
            }
          }
        }
      } catch (e) {
        void e; // 死信转移失败 → 下一轮心跳重试
      }
    }
    const dir = inboxDir(rt, rt.SELF_PID);
    if (!existsSync(dir)) return;
    for (const f of await readdir(dir)) {
      if (f.endsWith(".json")) await processInboxItem(rt, pi, join(dir, f));
    }
  } finally {
    rt.draining = false;
  }
}

/** 网关消费 outbox：替工作实例把回复发到飞书 */
export async function drainOutbox(rt: BotRuntime) {
  if (rt.outboxDraining || !rt.channel) return;
  rt.outboxDraining = true;
  try {
    const dir = join(INBOX_ROOT, String(rt.SELF_PID), "outbox");
    if (!existsSync(dir)) return;
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const fp = join(dir, f);
      try {
        const payload = JSON.parse(await readFile(fp, "utf8"));
        await rm(fp).catch(() => {});
        if (payload?.kind === "send" && payload.chatId && payload.md) {
          await rt.svc.sendToChat(payload.chatId, payload.md);
        }
      } catch (e: any) {
        console.error("[feishubot] outbox 处理失败:", e?.message || e);
      }
    }
  } finally {
    rt.outboxDraining = false;
  }
}

export function startInboxWatcher(rt: BotRuntime) {
  const dir = inboxDir(rt, rt.SELF_PID);
  if (!existsSync(dir)) {
    mkdir(dir, { recursive: true }).catch(() => {});
  }
  try {
    rt.inboxWatcher?.close();
  } catch (e) {
    void e; // 旧 watcher 未初始化
  }
  try {
    rt.inboxWatcher = fsWatch(dir, () => void rt.svc.drainInbox());
  } catch (e: any) {
    console.error("[feishubot] inbox watch 失败:", e?.message);
  }
  // 网关：监听自己的 outbox（工作实例委托的回复）→ 秒级代发
  const outDir = join(INBOX_ROOT, String(rt.SELF_PID), "outbox");
  if (!existsSync(outDir)) {
    mkdir(outDir, { recursive: true }).catch(() => {});
  }
  try {
    rt.outboxWatcher?.close();
  } catch (e) {
    void e; // 旧 watcher 未初始化
  }
  try {
    rt.outboxWatcher = fsWatch(outDir, () => void rt.svc.drainOutbox());
  } catch (e: any) {
    console.error("[feishubot] outbox watch 失败:", e?.message);
  }
  // 启动时处理残留（上次崩溃/退出未消费的）
  void rt.svc.drainInbox();
  if (rt.isGateway && rt.channel) void rt.svc.drainOutbox();
}
