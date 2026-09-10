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
/** 信箱文件入口：读内容 → 删文件（拿所有权）→ 纯处理 */
export async function processInboxItem(rt: BotRuntime, pi: any, file: string) {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e: any) {
    console.error("[feishubot] inbox 读取失败:", e?.message || e);
    return;
  }
  await rm(file).catch(() => {});
  await processInboxRaw(rt, pi, raw);
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
                  // 先读后删：rm 前置会让 processInboxItem 重读已删文件（ENOENT + 内容丢失）
                  const full = inboxDir(rt, pid) + "/" + f;
                  let raw: string | null = null;
                  try {
                    raw = await readFile(full, "utf8");
                  } catch (err) {
                    void err; // 文件已消失
                  }
                  await rm(full).catch(() => {});
                  if (raw == null) continue;
                  await processInboxRaw(rt, pi, raw).catch(() => {});
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

/**
 * 挂载信箱监听（async：目录就绪后再 fsWatch，修复新实例首启的 ENOENT 竞态 ——
 * 原实现 mkdir 异步发射后不管，fsWatch 同步执行时目录尚未存在）
 */
export function startInboxWatcher(rt: BotRuntime) {
  void ensureDirsAndWatch(rt);
  // 兜底轮询：fs.watch 在 macOS 对高频目录会静默失效（探针实测）——
  // 3s 轮询保证最坏延迟有界，watcher 正常时事件即时触发（draining 互斥去重）
  if (!rt.mailboxPollTimer) {
    rt.mailboxPollTimer = setInterval(() => {
      void rt.svc.drainInbox();
      if (rt.isGateway && rt.channel) void rt.svc.drainOutbox();
    }, 3000);
  }
}

async function ensureDirsAndWatch(rt: BotRuntime) {
  const dir = inboxDir(rt, rt.SELF_PID);
  await mkdir(dir, { recursive: true });
  const outDir = join(INBOX_ROOT, String(rt.SELF_PID), "outbox");
  await mkdir(outDir, { recursive: true });

  attachWatch(rt, "inboxWatcher", dir, () => void rt.svc.drainInbox());
  attachWatch(rt, "outboxWatcher", outDir, () => void rt.svc.drainOutbox());

  // 启动时处理残留（上次崩溃/退出未消费的）
  void rt.svc.drainInbox();
  if (rt.isGateway && rt.channel) void rt.svc.drainOutbox();
}

/** 挂单个 watch；error/失效时自动重建目录并重挂（自愈） */
function attachWatch(
  rt: BotRuntime,
  slot: "inboxWatcher" | "outboxWatcher",
  dir: string,
  onChange: () => void,
) {
  try {
    (rt as any)[slot]?.close();
  } catch (e) {
    void e; // 旧 watcher 未初始化
  }
  try {
    const w = fsWatch(dir, () => onChange());
    // fs.watch 在目录被删/失效时经 error 事件暴露 → 清目录重挂
    (w as any).on?.("error", () => {
      try {
        w.close();
      } catch (e) {
        void e;
      }
      if ((rt as any)[slot] === w) {
        (rt as any)[slot] = null;
        mkdir(dir, { recursive: true })
          .then(() => attachWatch(rt, slot, dir, onChange))
          .catch(() => {});
      }
    });
    (rt as any)[slot] = w;
  } catch (e: any) {
    console.error(`[feishubot] ${slot} watch 失败（5s 后重挂）:`, e?.message);
    setTimeout(() => attachWatch(rt, slot, dir, onChange), 5000);
  }
}
