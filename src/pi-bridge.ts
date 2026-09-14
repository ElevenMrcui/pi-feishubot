/**
 * pi-bridge.ts — Observer 模式：pi 事件订阅与命令注册
 *
 * 事件桥：
 * - message_update（token 级 text_delta）→ 打字机卡片增量
 * - tool_execution_* → 进度跟踪
 * - agent_end → 按注入前缀配对回复（防早夭/防重复定格）
 * - session_start/shutdown → 生命周期（注册/心跳/连接/清理）
 *
 * 命令：/feishubot-add|remove|reconnect|status + 内部通道命令
 * （switch-session/new-session/reload 由命令通道以 ExtensionCommandContext 执行）
 */
import { watch as _fsWatch } from "node:fs";
import { mkdir as _mkdir } from "node:fs/promises";
import { join as _join } from "node:path";
import { homedir as _homedir } from "node:os";
import type { BotRuntime, FeishuRequest, PendingReply } from "./types.ts";
import { finalizeRequest, ensureStream, stopProgressNotifier } from "./streaming.ts";
import { sendReplyOut } from "./sender.ts";
import { summarizeArgs } from "./utils.ts";
import { readBindings } from "./storage.ts";
import { writeInstanceHeartbeat } from "./instances.ts";
import { startInboxWatcher, drainInbox, stopInboxWatcher } from "./mailbox.ts";
import {
  connect,
  disconnect,
  startHeartbeat,
  teardown,
} from "./channel-gateway.ts";
import { isSDKAvailable } from "./sdk.ts";
import { loadConfig, saveConfig, deleteConfig } from "./storage.ts";

// ========================================================================
// 事件订阅
// ========================================================================

/** finalizedMessageIds 带 TTL（30min，心跳周期清扫；防长期运行内存泄漏） */
function markFinalized(rt: BotRuntime, id: string) {
  rt.finalizedMessageIds.set(id, Date.now());
}

/** 安全投递：异步失败仅记日志，绝不冒泡（feishubot 不崩宿主） */
function safeFire(p: Promise<unknown>, label: string) {
  p.catch((e: any) => {
    console.error(`[feishubot] ${label} 异步失败:`, e?.message || e);
  });
}

export function registerPiObservers(rt: BotRuntime, pi: any) {
  // token 级流式 → 打字机卡片
  // 注意：不以 rt.connected 作门禁 —— 工作实例（无 WS）也处理：
  // ensureStream 内部无 channel 时自会 no-op，但 buffer 累积是 agent_end 兜底回传的依据
  pi.on("message_update", (e: any) => {
    const msg = e.message as any;
    if (msg?.role !== "assistant") return;
    const evt = e.assistantMessageEvent;
    if (evt?.type !== "text_delta" || !evt.delta) return;

    const req = rt.activeRequest;
    if (!req || req.finalized) return;
    req.streamBuffer += evt.delta;
    req.lastActivityAt = Date.now();
    ensureStream(rt, req);
  });

  pi.on("tool_execution_start", (e: any) => {
    rt.activeToolInfo = {
      name: e.toolName,
      argsSummary: summarizeArgs(e.args),
      startedAt: Date.now(),
    };
  });

  pi.on("tool_execution_end", () => {
    rt.activeToolInfo = null;
  });

  pi.on("before_agent_start", () => {
    rt.activeToolInfo = null;
    // 新 run 启动 = 上一个 agent_end 属中途态：暂停延投轮询（不把半程叙述当最终回复发出）
    for (const p of rt.pendingReplies.values()) {
      if (p.timer) {
        clearTimeout(p.timer);
        p.timer = null;
      }
      p.expiresAt = Math.max(p.expiresAt, Date.now() + PENDING_EXPIRE_MS);
    }
  });

  pi.on("agent_end", async (e: any) => {
    // 不以 rt.connected 作门禁：工作实例（无 WS，拿不到网关锁）也必须回传！
    // 回复投递不依赖本实例 WS —— sendReplyOut 有委托网关通路；
    // 是否本扩展的消息由 [feishubot] 注入前缀匹配过滤。
    // 异常边界：回复配对/投递的任何失败只记日志（绝不崩 pi 宿主）。
    try {
      await pairAndDeliverReplies(rt, e.messages as any[]);
    } catch (e: any) {
      console.error("[feishubot] agent_end 回复配对异常:", e?.message || e);
    }
  });

  // ======================================================================
  // 生命周期
  // ======================================================================

  pi.on("session_start", async (_e: any, ctx: any) => {
   try {
    rt.currentCtx = ctx;
    if (!isSDKAvailable()) return;
    const table = await readBindings();
    rt.chatBindings = table.chats;
    rt.senderBindings = table.senders;
    // 任务监听的通知目标：绑定到本实例（综合）会话的聊天
    (rt as any).__boundChats = Object.entries(table.chats || {})
      .filter(([, p]) => p === (rt.currentCtx as any)?.sessionManager?.sessionFile)
      .map(([c]) => c);
    // 实例注册 + 心跳（多实例自动入网；新实例启动即出现在 实例 列表）
    await writeInstanceHeartbeat(rt);
    startHeartbeat(rt, ctx, pi);
    await startInboxWatcher(rt);
    await drainInbox(rt, pi);
    // faunet 任务完成监听（网关实例专用；由 startTaskWatcher 内部判断）
    const { startTaskWatcher } = await import("./task-watcher.ts");
    startTaskWatcher(rt);
    const cfg = await loadConfig();
    if (cfg) {
      await connect(rt, ctx); // 内部有网关锁门禁：非网关实例自动转工作模式
    } else {
      console.log(
        "[feishubot] 未配置，进入配置监视模式（config.json 出现后自动连接）",
      );
      startConfigAutoConnect(rt, ctx);
    }
   } catch (e: any) {
    console.error("[feishubot] session_start 异常:", e?.message || e);
   }
  });

  /** 未配置时的自愈：监视 config.json 出现（fs.watch + 15s 兜底轮询）→ 自动连接 */
  function startConfigAutoConnect(rt: BotRuntime, ctx: any) {
    const CONFIG_DIR = _join(_homedir(), ".pi", "agent", "feishu-bot");
    if (rt.configPollTimer) return;
    const tryConnect = async () => {
      if (rt.connected) return stopAutoConnect(rt);
      const cfg = await loadConfig();
      if (!cfg) return;
      stopAutoConnect(rt);
      console.log("[feishubot] 检测到配置出现，自动连接…");
      await connect(rt, ctx);
    };
    // fs.watch（目录先确保存在，避免 ENOENT）
    _mkdir(CONFIG_DIR, { recursive: true })
      .then(() => {
        if (rt.configWatcher) return;
        try {
          rt.configWatcher = _fsWatch(CONFIG_DIR, (_ev, fname) => {
            if (!fname || String(fname) === "config.json") void tryConnect();
          });
          rt.configWatcher.on?.("error", () => {
            try {
              rt.configWatcher?.close();
            } catch (e) {
              void e;
            }
            rt.configWatcher = null;
          });
        } catch (e: any) {
          console.error("[feishubot] config watch 失败（15s 轮询兜底）:", e?.message);
        }
      })
      .catch(() => {});
    rt.configPollTimer = setInterval(() => void tryConnect(), 15_000);
    void tryConnect();
  }

  function stopAutoConnect(rt: BotRuntime) {
    if (rt.configPollTimer) {
      clearInterval(rt.configPollTimer);
      rt.configPollTimer = null;
    }
    try {
      rt.configWatcher?.close();
    } catch (e) {
      void e;
    }
    rt.configWatcher = null;
  }

  pi.on("session_shutdown", async () => {
    for (const req of rt.requests.values()) {
      req.finalized = true;
      if (req.streamFlushTimer) clearInterval(req.streamFlushTimer);
    }
    for (const p of rt.pendingReplies.values()) {
      if (p.timer) clearTimeout(p.timer);
    }
    rt.pendingReplies.clear();
    rt.requests.clear();
    rt.activeRequest = null;
    if (rt.heartbeatTimer) clearInterval(rt.heartbeatTimer);
    rt.heartbeatTimer = null;
    if (rt.mailboxPollTimer) clearInterval(rt.mailboxPollTimer);
    rt.mailboxPollTimer = null;
    const { stopTaskWatcher } = await import("./task-watcher.ts");
    stopTaskWatcher(rt);
    stopInboxWatcher(rt);
    await teardown(rt);
    disconnect(rt);
  });
}

/**
 * agent_end 回复配对：遍历消息找 [feishubot] 注入的 user 消息，
 * 收集其后的 assistant 文本，定格流式卡片或走回复出口。
 */
async function pairAndDeliverReplies(rt: BotRuntime, messages: any[]) {
  for (let i = 0; i < messages.length; i++) {
    const userMsg = messages[i];
    if (userMsg.role !== "user") continue;
    const userText = (userMsg.content as any[])?.find(
      (b: any) => b.type === "text",
    )?.text;
    if (!userText || !userText.startsWith("[feishubot]")) continue;

    const m = userText.match(/^\[feishubot\] \[.*?\] \[(.+?)\] \[(.+?)\]\n/);
    if (!m) continue;
    const chatId = m[1];
    const messageId = m[2];

    // 1. 防重：已经 finalize 过或已回复的历史消息跳过
    if (rt.finalizedMessageIds.has(messageId)) continue;

    const req = rt.requests.get(messageId);
    if (req && req.finalized) {
      markFinalized(rt, messageId);
      continue;
    }

    // 2. 收集该 user 之后所有 assistant 文本（含工具轮次）
    const parts: string[] = [];
    for (let j = i + 1; j < messages.length; j++) {
      const mm = messages[j];
      if (mm.role === "user") break;
      if (mm.role === "assistant") {
        const t = (mm.content as any[])?.find(
          (b: any) => b.type === "text",
        )?.text;
        if (t && t.trim()) parts.push(t.trim());
      }
    }
    let content = parts.join("\n\n").trim();
    // 工具轮次本回合无文本 → 优先用流式已缓冲的内容
    if (!content && req?.streamBuffer?.trim())
      content = req.streamBuffer.trim();

    // 3. 防早夭（v2.2.9）：agent_end ≠ 已空闲 —— agent_end 之后 pi 会对长会话
    //    自动压缩（isCompacting）、bai failover 也会排队续跑，两种情况下
    //    isIdle() 均为 false。v2.2.8 在此直接 continue 会把回复永久丢弃
    //    （真实事故：重载后回复全丢，进度播报跑到 600s 上限）。
    //    正确做法：挂起延投 —— 空闲后补投最新内容，超时兜底必投。
    if (rt.currentCtx && !rt.currentCtx.isIdle()) {
      if (!req) {
        // 历史孤儿消息（本运行时未跟踪，如重载前旧轮次）：不补发防刷屏
        markFinalized(rt, messageId);
        continue;
      }
      stashPendingReply(rt, messageId, chatId, req, content);
      continue;
    }
    deletePendingReply(rt, messageId); // 已空闲：立即投递，撤销挂起

    // 4. 彻底结束但仍无文本：补兜底文案
    if (!content) {
      content = "⚠️ 任务已结束，但未产生回复文本。";
    }

    // 5. 正式定格或发送
    await deliverReply(rt, messageId, chatId, req, content);
  }
}

// ========================================================================
// 延投队列（agent_end 时未空闲：自动压缩 / failover 续跑）
// ========================================================================

const PENDING_POLL_MS = 2_000;
const PENDING_EXPIRE_MS = 180_000;

function stashPendingReply(
  rt: BotRuntime,
  messageId: string,
  chatId: string,
  req: FeishuRequest,
  content: string,
) {
  const prev = rt.pendingReplies.get(messageId);
  // 保留最长（= 最完整）的一份：failover 续跑后最后轮次会补齐全文
  const merged =
    content.length >= (prev?.content.length ?? 0)
      ? content
      : (prev as PendingReply).content;
  if (prev?.timer) clearTimeout(prev.timer);
  const pending: PendingReply = {
    messageId,
    chatId,
    req,
    content: merged,
    stashedAt: prev?.stashedAt || Date.now(),
    expiresAt: Date.now() + PENDING_EXPIRE_MS,
    timer: null,
  };
  rt.pendingReplies.set(messageId, pending);
  ensurePendingPoll(rt, pending);
}

function deletePendingReply(rt: BotRuntime, messageId: string) {
  const p = rt.pendingReplies.get(messageId);
  if (p?.timer) clearTimeout(p.timer);
  rt.pendingReplies.delete(messageId);
}

/** 轮询补投：空闲即投，超时兜底（保证“至少收到一条”）；run 重启时由
 *  before_agent_start 暂停，避免把半程叙述当最终回复发出 */
function ensurePendingPoll(rt: BotRuntime, p: PendingReply) {
  if (p.timer) return;
  const tick = () => {
    p.timer = null;
    const cur = rt.pendingReplies.get(p.messageId);
    if (!cur || cur !== p) return; // 已由空闲路径投递
    const idle = !rt.currentCtx || rt.currentCtx.isIdle?.() !== false;
    if (!idle && Date.now() < p.expiresAt) {
      p.timer = setTimeout(tick, PENDING_POLL_MS);
      return;
    }
    rt.pendingReplies.delete(p.messageId);
    void deliverReply(rt, p.messageId, p.chatId, p.req, p.content).catch(
      (e: any) => console.error("[feishubot] 延投失败:", e?.message || e),
    );
  };
  p.timer = setTimeout(tick, PENDING_POLL_MS);
}

/** 回复投递唯一出口（定格流式卡片 / 直发或委托网关），同步与延投共用 */
async function deliverReply(
  rt: BotRuntime,
  messageId: string,
  chatId: string,
  req: FeishuRequest | undefined,
  content: string,
): Promise<void> {
  if (rt.finalizedMessageIds.has(messageId)) return;
  markFinalized(rt, messageId);
  if (req) req.finalized = true;
  rt.stats.replied++;
  const text = content.trim() || "⚠️ 任务已结束，但未产生回复文本。";
  if (req && !req.viaInbox) {
    await finalizeRequest(rt, req, text);
  } else {
    // 跨实例投递的消息（无流式卡片）：先停进度播报，再走回复出口
    if (req) stopProgressNotifier(req);
    await sendReplyOut(rt, chatId, text);
  }
}

// ========================================================================
// pi 命令注册
// ========================================================================

export function registerPiCommands(rt: BotRuntime, pi: any) {
  pi.registerCommand("feishubot-add", {
    description: "添加飞书机器人凭据",
    handler: async (_args: any, ctx: any) => {
      const appId = await ctx.ui.input("飞书 App ID (cli_ 开头)", "");
      if (!appId) return;
      const appSecret = await ctx.ui.input("飞书 App Secret", "");
      if (!appSecret) return;
      await saveConfig({ appId: appId.trim(), appSecret: appSecret.trim() });
      ctx.ui.notify("✅ 凭据已保存，正在连接...", "info");
      await connect(rt, ctx);
    },
  });

  pi.registerCommand("feishubot-remove", {
    description: "删除飞书机器人配置",
    handler: async (_args: any, ctx: any) => {
      if (!(await ctx.ui.confirm("确认删除飞书机器人配置？"))) return;
      await deleteConfig();
      disconnect(rt);
      ctx.ui.notify("✅ 已删除", "info");
    },
  });

  pi.registerCommand("feishubot-reconnect", {
    description: "重新连接飞书",
    handler: async (_args: any, ctx: any) => {
      await connect(rt, ctx);
    },
  });

  pi.registerCommand("feishubot-status", {
    description: "查看飞书机器人状态",
    handler: async (_args: any, ctx: any) => {
      const cfg = await loadConfig();
      if (!cfg) {
        ctx.ui.notify("飞书机器人: ❌ 未配置（/feishubot-add）", "info");
        return;
      }
      ctx.ui.notify(
        `飞书机器人: ${rt.connected ? "✅ 已连接" : "❌ 未连接"}\nBot: ${rt.botName}\nAppID: ${cfg.appId}`,
        "info",
      );
    },
  });

  // 内部命令：由 pi 核心以 ExtensionCommandContext 执行，具备 switchSession 与 newSession 权限
  pi.registerCommand("feishubot-switch-session", {
    description: "飞书内部会话切换通道",
    handler: async (args: any, cmdCtx: any) => {
      const sessionPath = String(args || "").trim();
      if (!sessionPath) return;
      if (typeof cmdCtx.switchSession === "function") {
        await cmdCtx.switchSession(sessionPath);
      }
    },
  });

  pi.registerCommand("feishubot-new-session", {
    description: "飞书内部新建会话通道",
    handler: async (_args: any, cmdCtx: any) => {
      if (typeof cmdCtx.newSession === "function") {
        await cmdCtx.newSession();
      }
    },
  });

  pi.registerCommand("feishubot-reload", {
    description: "飞书内部重载扩展通道",
    handler: async (_args: any, cmdCtx: any) => {
      if (typeof cmdCtx.reload === "function") {
        await cmdCtx.reload();
      }
    },
  });
}
