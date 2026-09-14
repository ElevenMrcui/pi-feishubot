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
import { join, dirname } from "node:path";
import { existsSync, watch as fsWatch, rmSync, mkdirSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { INBOX_ROOT } from "./storage.ts";
import type { BotRuntime, FeishuRequest, InstanceInfo } from "./types.ts";
import { listLiveInstances } from "./instances.ts";
import { sleep } from "./utils.ts";

// ======== 信箱 watch 看门狗（探针自愈）========
// FSEvents 静默失效无异常可捕获：周期性写探针文件，若 watch 未在容差内
// 反应 → 判定失效，立即重挂。比 3s 兕底轮询更快恢复事件驱动投递。
let probeTimer: NodeJS.Timeout | null = null;
let probeSeenAt = 0;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TOLERANCE_MS = 4_000;
// 死信接管扫描降频：接管/清目录要遍历整个 INBOX_ROOT，60s 一次足够
// （消息投递路径不依赖它：直接写给存活实例的信箱照常即时消费）
let lastTakeoverScanAt = 0;
const TAKEOVER_SCAN_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------- 跨实例唤醒通道

/**
 * 写完信件/代发件后通知目标实例立即 drain，把信箱投递延迟从最坏 3s 降到 ~3ms。
 *
 * 设计：每实例一个 Unix domain socket（inbox/{pid}/wake.sock），无需端口协商、
 * 天然按实例隔离。notifyWake 尽力而为：失败/无 socket 一律静默，3s 轮询始终
 * 作为兜底防线（语义上 socket 只是加速器，不是正确性依赖）。
 */
export function wakeSocketPath(pid: number) {
  return join(INBOX_ROOT, String(pid), "wake.sock");
}

let wakeServer: Server | null = null;

/** 通知目标实例“有活了”（fire-and-forget，错误吐掉由轮询兜底） */
export function notifyWake(pid: number): void {
  if (!pid) return;
  const path = wakeSocketPath(pid);
  if (!existsSync(path)) return; // 目标未监听 → 靠 3s 轮询
  try {
    const sock = createConnection({ path }, () => {
      try {
        sock.write("1");
      } catch (e) {
        void e;
      }
      sock.destroy();
    });
    sock.setTimeout(500, () => sock.destroy());
    sock.on("error", () => sock.destroy()); // 目标已死/竞态 → 忽略
  } catch (e) {
    void e;
  }
}

function wakeNow(rt: BotRuntime) {
  // 正在消化 → 250ms 后补一轮，消除“信件落在本次 drain 扫描之后”的竞态
  if (rt.draining || rt.outboxDraining) {
    setTimeout(() => wakeNow(rt), 250).unref?.();
    return;
  }
  safeFire(rt.svc.drainInbox(), "drainInbox:wake");
  if (rt.isGateway && rt.channel)
    safeFire(rt.svc.drainOutbox(), "drainOutbox:wake");
}

export function startWakeListener(rt: BotRuntime) {
  if (wakeServer) return;
  const path = wakeSocketPath(rt.SELF_PID);
  try {
    // 首次启动时 ensureDirsAndWatch 是异步的（fire-and-forget），socket 路径
    // 所在目录必须已存在，否则 listen 直接 ENOENT → 唤醒能力永久丢失
    mkdirSync(dirname(path), { recursive: true });
    // 上次进程异常退出（kill/崩）遗留的 socket 会让 listen 直接 EADDRINUSE
    if (existsSync(path)) rmSync(path, { force: true });
  } catch (e) {
    void e;
  }
  try {
    const srv = createServer(() => wakeNow(rt));
    srv.on("error", (e: any) => {
      console.warn(
        `[feishubot] 唤醒 socket 不可用，退回 3s 轮询（${e?.code || e?.message}）`,
      );
      wakeServer = null;
    });
    srv.listen(path);
    wakeServer = srv;
  } catch (e: any) {
    console.warn(
      `[feishubot] 唤醒 socket 启动失败，退回 3s 轮询（${e?.message}）`,
    );
    wakeServer = null;
  }
}

export function stopWakeListener(rt: BotRuntime) {
  if (wakeServer) {
    try {
      wakeServer.close();
    } catch (e) {
      void e;
    }
    wakeServer = null;
  }
  try {
    const path = wakeSocketPath(rt.SELF_PID);
    if (existsSync(path)) rmSync(path, { force: true });
  } catch (e) {
    void e;
  }
}

/** 安全投递：异步操作永不冒泡为 unhandledRejection（feishubot 不得崩掉 pi 宿主） */
function safeFire(p: Promise<unknown>, label: string) {
  p.catch((e: any) => {
    console.error(`[feishubot] ${label} 异步失败:`, e?.message || e);
  });
}

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
  notifyWake(gatewayPid); // 唤醒网关立即代发（否则最坏等 1s 心跳/3s 轮询）
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
  notifyWake(target.pid); // 唤醒目标实例：投递延迟 3s → ~3ms
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
  rt.seenMessages.set(payload.messageId, Date.now());

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
    // （仅网关执行，避免多实例重复转移；60s 降频扫描，转移用 rename，
    // 天然走正常处理路径）
    if (
      rt.isGateway &&
      rt.channel &&
      Date.now() - lastTakeoverScanAt > TAKEOVER_SCAN_INTERVAL_MS
    ) {
      lastTakeoverScanAt = Date.now();
      let livePids: Set<number> | null = null;
      try {
        const live = await listLiveInstances(rt);
        livePids = new Set(live.map((x) => x.pid));
      } catch (e) {
        void e; // 实例表不可用 → 本轮跳过接管与清理
      }
      if (livePids && existsSync(INBOX_ROOT)) {
        for (const d of await readdir(INBOX_ROOT)) {
          const pid = parseInt(d, 10);
          if (Number.isNaN(pid) || livePids.has(pid) || pid === rt.SELF_PID)
            continue;
          const deadDir = inboxDir(rt, pid);
          try {
            // 1) 未消化信件 → 接管到自己 inbox（rename 天然走正常处理路径：
            //    读→删→解析，无 ENOENT、无内容丢失）
            const letters = (await readdir(deadDir).catch(() => [])).filter(
              (f) => f.endsWith(".json"),
            );
            if (letters.length) {
              console.log(
                `[feishubot] 接管已死实例 PID ${pid} 的 ${letters.length} 条信件`,
              );
              for (const f of letters) {
                await rename(join(deadDir, f), join(inboxDir(rt, rt.SELF_PID), f)).catch(() => {});
              }
            }
            // 2) 死网关遗留的代发回复 → 挪进自己 outbox 补发
            //（整目录回收前必须先救出来，否则丢失本该代发的回复）
            const deadOut = join(deadDir, "outbox");
            const stranded = (await readdir(deadOut).catch(() => [])).filter(
              (f) => f.endsWith(".json"),
            );
            for (const f of stranded) {
              console.log(`[feishubot] 接管已死网关 PID ${pid} 的代发回复 ${f}`);
              await rename(
                join(deadOut, f),
                join(inboxDir(rt, rt.SELF_PID), "outbox", f),
              ).catch(() => {});
            }
            // 3) 确认无信件后整目录回收。旧实现要求目录 readdir 为空，但每个实例
            //    目录都有 outbox 子目录占位 → 条件永不成立，实测死目录堆积 25 个
            const hasMail = async (dir: string) =>
              (await readdir(dir).catch(() => [])).some((f) =>
                f.endsWith(".json"),
              );
            if (
              !(await hasMail(deadDir)) &&
              !(await hasMail(join(deadDir, "outbox")))
            ) {
              await rm(deadDir, { recursive: true, force: true }).catch(
                () => {},
              );
            }
          } catch (e) {
            void e; // 单实例失败 → 下一轮重试
          }
        }
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
  safeFire(ensureDirsAndWatch(rt), "ensureDirsAndWatch");
  startWakeListener(rt);
  if (!rt.mailboxPollTimer) {
    rt.mailboxPollTimer = setInterval(() => {
      safeFire(rt.svc.drainInbox(), "drainInbox");
      if (rt.isGateway && rt.channel) safeFire(rt.svc.drainOutbox(), "drainOutbox");
    }, 3000);
  }
  // watch 看门狗：周期探针验证 FSEvents 活性，静默失效立即重挂
  if (!probeTimer) {
    probeTimer = setInterval(() => {
      safeFire(runWatchdogProbe(rt), "watchdogProbe");
    }, PROBE_INTERVAL_MS);
  }
}

/** 停止信箱监听（探针 + watcher；session_shutdown 用） */
export function stopInboxWatcher(rt: BotRuntime) {
  stopWakeListener(rt);
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
  for (const slot of ["inboxWatcher", "outboxWatcher"] as const) {
    const w = (rt as any)[slot];
    if (w) {
      try {
        w.close();
      } catch (e) {
        void e; // watcher 未初始化
      }
      (rt as any)[slot] = null;
    }
  }
}

async function runWatchdogProbe(rt: BotRuntime) {
  const dir = inboxDir(rt, rt.SELF_PID);
  probeSeenAt = 0;
  try {
    await writeFile(join(dir, ".probe"), String(Date.now()));
  } catch (e) {
    void e; // 目录还没建好 → ensureDirsAndWatch 会建
    return;
  }
  await sleep(PROBE_TOLERANCE_MS);
  if (probeSeenAt === 0) {
    console.log("[feishubot] watchdog：inbox watcher 无响应，重挂…");
    attachWatch(rt, "inboxWatcher", dir, makeInboxChange(rt));
    // 重挂后立即补一轮 drain（失效期间的信件可能已堆积）
    safeFire(rt.svc.drainInbox(), "drainInbox");
  }
}

function makeInboxChange(rt: BotRuntime) {
  return () => {
    probeSeenAt = Date.now();
    safeFire(rt.svc.drainInbox(), "drainInbox");
  };
}

async function ensureDirsAndWatch(rt: BotRuntime) {
  const dir = inboxDir(rt, rt.SELF_PID);
  const outDir = join(INBOX_ROOT, String(rt.SELF_PID), "outbox");
  // mkdir 竞态防护：递归创建在并发删父目录时可能 ENOENT → 3 次退避重试
  for (const d of [dir, outDir]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await mkdir(d, { recursive: true });
        break;
      } catch (e: any) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }

  attachWatch(rt, "inboxWatcher", dir, makeInboxChange(rt));
  attachWatch(rt, "outboxWatcher", outDir, () => safeFire(rt.svc.drainOutbox(), "drainOutbox"));

  // 启动时处理残留（上次崩溃/退出未消费的）
  safeFire(rt.svc.drainInbox(), "drainInbox");
  if (rt.isGateway && rt.channel) safeFire(rt.svc.drainOutbox(), "drainOutbox");
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
