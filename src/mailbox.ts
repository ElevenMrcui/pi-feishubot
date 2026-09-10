/**
 * mailbox.ts — Mediator 模式的传输层：跨实例信箱
 *
 * - inbox/{pid}/{messageId}.json —— 网关把消息路由到承载目标会话的实例
 * - outbox/{gatewayPid}/*.json —— 工作实例的回复委托网关代发（兜底通路）
 * - 死实例的信件由网关接管（rename 到自己信箱，天然走正常处理路径）
 *
 * 可靠性三防线（v2.2.1+）：
 * 1. processInboxItem 读到内容即删文件（毒丸/残缺 JSON 不循环）
 * 2. 死信转移 rename 前置读（先删后读会 ENOENT + 内容丢失）
 * 3. fs.watch 静默失效（macOS FSEvents 已实测）→ error 自动重挂 + 3s 兜底轮询
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

/** 信箱文件入口：读内容 → 删文件（拿所有权）→ 纯处理（毒丸不循环） */
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

/** 纯处理：解析信封 → 快捷指令 → 注入 pi → ack/进度 */
async function processInboxRaw(rt: BotRuntime, pi: any, raw: string) {
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch (e: any) {
    console.error("[feishubot] 信件 JSON 损坏，已丢弃:", e?.message || e);
    return;
  }
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
    progressTimer: null,
    progressSent: 0,
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
  rt.stats.received++;
  // worker 即时 ack：注入成功即回执（网关实例走占位卡，worker 无流式 → 文本回执）
  const busy = rt.currentCtx && !rt.currentCtx.isIdle();
  void rt.svc
    .sendToChat(
      req.chatId,
      busy
        ? "🫥 收到，已排队（当前有任务执行中，完成后处理）…"
        : "🫥 收到，开始处理…",
    )
    .catch(() => {});
  const injectText = `[feishubot] [${req.senderName}] [${req.chatId}] [${req.messageId}]\n${payload.text}`;
  try {
    await pi.sendUserMessage([{ type: "text", text: injectText }], {
      deliverAs: "steer",
    });
  } catch (e: any) {
    console.error("[feishubot] 注入 pi 失败:", e?.message || e);
    rt.requests.delete(req.messageId);
    if (rt.activeRequest === req) rt.activeRequest = null;
    await rt.svc
      .sendToChat(req.chatId, "⚠️ 消息注入失败，请稍后重试。")
      .catch(() => {});
    return;
  }
  rt.svc.scheduleAck(req);
  // 无流式卡片的实例：启动文本进度播报（30s 节流，工具级状态可见）
  const { startProgressNotifier } = await import("./streaming.ts");
  startProgressNotifier(rt, req);
}

export async function drainInbox(rt: BotRuntime, pi: any) {
  if (rt.draining) return;
  rt.draining = true;
  try {
    // 死信转移：其它实例的信箱若属已死进程 → 存活实例接管消化
    // （仅网关执行，避免多实例重复转移）；转移用 rename，天然走正常处理路径
    if (rt.isGateway && rt.channel) {
      try {
        const live = await listLiveInstances(rt);
        const livePids = new Set(live.map((x) => x.pid));
        if (existsSync(INBOX_ROOT)) {
          for (const d of await readdir(INBOX_ROOT)) {
            const pid = parseInt(d, 10);
            if (Number.isNaN(pid) || livePids.has(pid) || pid === rt.SELF_PID)
              continue;
            const deadDir = inboxDir(rt, pid);
            let files: string[] = [];
            try {
              files = (await readdir(deadDir)).filter((f) => f.endsWith(".json"));
            } catch (e) {
              void e; // 目录已消失
              continue;
            }
            if (!files.length) continue;
            console.log(
              `[feishubot] 接管已死实例 PID ${pid} 的 ${files.length} 条信件`,
            );
            for (const f of files) {
              // rename 到自己信箱：本轮 drainInbox 后半段按正常路径处理
              // （读→删→解析），无 ENOENT、无内容丢失
              const full = join(deadDir, f);
              await rename(full, join(inboxDir(rt, rt.SELF_PID), f)).catch(
                () => {},
              );
            }
          }
        }
      } catch (e) {
        void e; // 死信转移失败 → 下一轮心跳重试
      }
      // 死实例的空目录清理
      try {
        for (const d of await readdir(INBOX_ROOT)) {
          const pid = parseInt(d, 10);
          if (!livePids?.has(pid) && pid !== rt.SELF_PID) {
            const p = inboxDir(rt, pid);
            if (existsSync(p) && (await readdir(p)).length === 0) {
              await rm(p, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
      } catch (e) {
        void e; // 清理失败无害
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
 * 挂载信箱监听 + 3s 兜底轮询。
 *
 * 可靠性说明（探针实测）：node fs.watch 在 macOS 对高频增删目录会静默失效
 * （FSEvents 句柄死亡，无异常）——因此 3s 轮询作为兜底防线，
 * watcher 正常时事件即时触发（draining 标志互斥去重），失效时最坏 3s 延迟。
 */
export function startInboxWatcher(rt: BotRuntime) {
  void ensureDirsAndWatch(rt);
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
  const current = (rt as any)[slot];
  if (current) {
    try {
      current.close();
    } catch (e) {
      void e; // 旧 watcher 未初始化
    }
    (rt as any)[slot] = null;
  }
  try {
    const w = fsWatch(dir, () => onChange());
    // fs.watch 在目录被删/失效时经 error 事件暴露 → 清目录重挂
    w.on?.("error", () => {
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
