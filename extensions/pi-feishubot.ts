/**
 * pi-feishubot v2 — 飞书官方 Channel SDK 接入扩展 for pi
 *
 * 基于 @larksuite/channel（官方文档指定 NodeJS SDK）：
 *   https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/integrate-feishu-channel
 *
 * 架构（v2 重写）：
 * - 传输：WebSocket 长连接（SDK 内置重连/心跳/去重/@策略/chat 串行）
 * - 入站：message 事件 → 零 token 快捷指令拦截 → steer 注入 pi
 * - 出站：token 级 text_delta → 飞书流式打字机卡片（channel.stream）
 * - 进度：阶梯式通知（仅流式卡片未建立前发文本，建立后卡片本身即进度）
 * - 收尾：agent_end → 按消息配对 → setContent 全文定格
 *
 * SDK 加载：createRequire 优先解析扩展旁路，回落独立安装目录
 *   ~/.pi/agent/feishubot/node_modules/@larksuite/channel
 */
// @ts-nocheck
import {
  readFile,
  writeFile,
  mkdir,
  chmod,
  unlink,
  open,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// ============================================================================
// SDK 加载
// ============================================================================

const require = createRequire(import.meta.url);
const SDK_DIR = join(homedir(), ".pi", "agent", "feishubot");

function loadSDK(): any {
  const candidates = [
    () => require("@larksuite/channel"),
    () => require(join(SDK_DIR, "node_modules", "@larksuite/channel")),
  ];
  for (const load of candidates) {
    try {
      const m = load();
      if (m?.createLarkChannel) return m;
    } catch {}
  }
  return null;
}

const SDK = loadSDK();
if (!SDK) {
  console.error(
    "[feishubot] @larksuite/channel 加载失败。执行: cd ~/.pi/agent/feishubot && npm install @larksuite/channel",
  );
}
const { createLarkChannel, LarkChannelError } = SDK || {};

// ============================================================================
// 配置
// ============================================================================

interface FeishuBotConfig {
  appId: string;
  appSecret: string;
  name?: string;
}

const CONFIG_DIR = join(homedir(), ".pi", "agent", "feishu-bot");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
/** 会话路由表：飞书 chatId → 绑定的 pi 会话文件绝对路径（持久化） */
const BINDINGS_FILE = join(CONFIG_DIR, "bindings.json");

async function loadConfig(): Promise<FeishuBotConfig | null> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    if (cfg.appId && cfg.appSecret) return cfg;
  } catch {}
  return null;
}

async function saveConfig(cfg: FeishuBotConfig) {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await chmod(CONFIG_DIR, 0o700).catch(() => {});
  }
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  await chmod(CONFIG_FILE, 0o600).catch(() => {});
}

async function deleteConfig() {
  try {
    await unlink(CONFIG_FILE);
  } catch {}
}

// ============================================================================
// 工具函数
// ============================================================================

const FAST_COMMAND_RE =
  /^(帮助|help|\/help|状态|进度|status|\/status|停止|中止|stop|\/stop|\/abort|当前模型|查看模型|模型|\/model|列出模型|可用模型|models|\/models|新会话|清空|\/new|\/clear|会话|sessions|\/sessions|会话列表|列表会话)$/i;
const MODEL_SWITCH_RE = /^(?:切换模型(?:到)?|\/model)\s+(.+)$/i;
/** 切换会话：`切会话 3` / `切会话 <session文件名或id片段>` / `/session 3` / `/sessions 3` */
const SESSION_SWITCH_RE = /^(?:切会话|切换会话|\/sessions?)\s+(.+)$/i;
/** 会话路由绑定：`绑定会话 <序号/ID/关键词>` —— 把当前飞书聊天固定路由到指定会话 */
const SESSION_BIND_RE = /^(?:绑定会话|会话绑定|bind)\s+(.+)$/i;
/** 解除绑定：`解绑会话` —— 恢复默认（消息进当前会话，不再自动路由） */
const SESSION_UNBIND_RE = /^(?:解绑会话|unbind)$/i;

function isFastCommandText(content: string): boolean {
  const s = content.trim();
  if (!s) return false;
  return (
    FAST_COMMAND_RE.test(s) ||
    MODEL_SWITCH_RE.test(s) ||
    SESSION_SWITCH_RE.test(s) ||
    SESSION_BIND_RE.test(s) ||
    SESSION_UNBIND_RE.test(s)
  );
}

function summarizeArgs(args: any): string {
  if (args == null) return "";
  try {
    if (typeof args === "string") return args.slice(0, 60);
    const parts: string[] = [];
    for (const k of [
      "command",
      "path",
      "file_path",
      "pattern",
      "query",
      "url",
      "skill",
    ]) {
      const v = args[k];
      if (typeof v === "string") parts.push(v.slice(0, 50));
    }
    if (!parts.length) {
      const j = JSON.stringify(args);
      return j && j !== "{}" ? j.slice(0, 60) : "";
    }
    return parts.join(" ").slice(0, 60);
  } catch {
    return "";
  }
}

/** 长文分段（段落优先），避免超长卡片被拒 */
function splitLongMarkdown(md: string, maxLen = 28000): string[] {
  if (md.length <= maxLen) return [md];
  const chunks: string[] = [];
  let rest = md;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** markdown → 纯文本（卡片发送失败降级） */
function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").trim())
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1($2)")
    .trim();
}

/**
 * 会话显示名：优先用户命名（SessionInfo.name），否则从会话 JSONL 文件头
 * 提取第一条真实用户消息（前 20 字）作为中文名。
 */
async function sessionDisplayName(s: any): Promise<string> {
  if (s.name) return s.name;
  try {
    const fh = await open(s.path, "r");
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    await fh.close();
    const head = buf.subarray(0, bytesRead).toString("utf8");
    for (const line of head.split("\n")) {
      if (!line.includes('"role":"user"')) continue;
      try {
        const e = JSON.parse(line);
        const msg = e?.message;
        if (msg?.role !== "user") continue;
        const c = msg.content;
        let txt = "";
        if (Array.isArray(c)) {
          const b = c.find((x: any) => x?.type === "text");
          if (b?.text) txt = String(b.text);
        } else if (typeof c === "string") {
          txt = c;
        }
        // 剥掉遥控注入头（[feishubot]/[dingtalkbot] 前缀行），取真实需求文本
        txt = txt.replace(/^\[(?:feishubot|dingtalkbot)\]\s*\[[^\n]*\n/, "");
        txt = txt.trim();
        if (!txt) continue;
        return txt.replace(/\s+/g, " ").slice(0, 20);
      } catch {}
    }
  } catch {}
  return s.id.slice(0, 8);
}

// ============================================================================
// 扩展主体
// ============================================================================

const PROMPT = `
[feishubot] 飞书机器人已连接
- 用户的消息来自飞书聊天窗口
- 你的文本回复会在任务结束时【自动发送给飞书用户】，切勿在回答中再次调用任何发送工具重复发送
- 不要主动切换、创建、恢复任何会话；会话管理完全由飞书扩展负责，用户提到切会话/换会话时回复提示其直接发送快捷指令
- 请使用清晰规范的 Markdown 格式输出（支持标题、列表、代码块、粗体等）`;

/** 单条飞书消息的处理上下文（v2 状态机） */
interface FeishuRequest {
  chatId: string;
  messageId: string;
  senderName: string;
  threadId?: string;
  phase: "thinking" | "streaming" | "done";
  streamCtrl: any | null; // MarkdownStreamController
  streamBuffer: string;
  streamFlushTimer: NodeJS.Timeout | null;
  streamAppended: number; // 已 append 的字符数
  finalized: boolean;
}

/** 流式卡片 flush 间隔（飞书卡片更新限流友好） */
const STREAM_FLUSH_MS = 700;

export default function (pi: ExtensionAPI) {
  let channel: any = null;
  let connected = false;
  let currentCtx: ExtensionContext | null = null;
  let botName = "Pi";

  // 活跃请求表：messageId → req（含正在处理与流式中）
  const requests = new Map<string, FeishuRequest>();
  // 当前流式输出目标（单槽：最后注入的消息）
  let activeRequest: FeishuRequest | null = null;
  // 最近一次列出的会话（`会话` 列表 → `切会话 <n>` 切换）
  let lastSessionList: any[] = [];

  // 全局状态跟踪（进度播报用）
  let activeToolInfo: {
    name: string;
    argsSummary: string;
    startedAt: number;
  } | null = null;

  // 入站去重兜底（SDK 已有 dedup，这里是防扩展内部重复触发的保险）
  const seenMessages = new Set<string>();
  // 已完成处理的飞书消息 ID，防止历史消息被重复处理或误触发兜底警告
  const finalizedMessageIds = new Set<string>();
  // 会话路由表：chatId → 会话文件路径（持久化到 bindings.json）
  let chatBindings: Record<string, string> = {};

  /** 当前实例所处的会话文件路径 */
  function currentSessionFile(): string {
    const sm = (currentCtx as any)?.sessionManager;
    if (!sm) return "";
    return (
      sm.sessionFile ||
      sm.sessionPath ||
      (typeof sm.getSessionFile === "function" ? sm.getSessionFile() : "") ||
      ""
    );
  }

  async function loadBindings() {
    try {
      chatBindings = JSON.parse(await readFile(BINDINGS_FILE, "utf8"));
    } catch {
      chatBindings = {};
    }
  }

  async function saveBindings() {
    if (!existsSync(CONFIG_DIR)) {
      await mkdir(CONFIG_DIR, { recursive: true });
      await chmod(CONFIG_DIR, 0o700).catch(() => {});
    }
    await writeFile(BINDINGS_FILE, JSON.stringify(chatBindings, null, 2));
  }

  /**
   * 解析会话目标：序号（最近列表）→ 精确 ID → ID 前缀（≥6 位）→ 名称 → 首条消息关键词。
   * 全量库实时检索，模糊匹配按最近修改优先。
   */
  async function resolveSessionTarget(arg: string): Promise<any | null> {
    // 自由文本归一化：从任意输入中提取会话 ID（UUID）或其前缀，
    // 兼容「绑定会话 会话 ID: 01a07c38-…」「切会话 id=01a07c38」等口语化输入
    const uuidMatch = arg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
      arg = uuidMatch[0];
    } else {
      // 无完整 UUID 时，提取 6-8 位 hex 片段（如 "01a07c38"）
      const hexMatch = arg.match(/\b[0-9a-f]{6,8}\b/i);
      if (hexMatch && !/^\d+$/.test(arg.trim())) {
        arg = hexMatch[0];
      }
    }
    const idx = /^\d+$/.test(arg) ? parseInt(arg, 10) - 1 : -1;
    if (lastSessionList && idx >= 0 && idx < lastSessionList.length) {
      return lastSessionList[idx];
    }
    try {
      const { SessionManager } = await import("@mariozechner/pi-coding-agent");
      let all: any[] = [];
      try {
        all = await SessionManager.list(currentCtx?.cwd || process.cwd());
      } catch {}
      if (!all || all.length === 0) {
        all = await SessionManager.listAll();
      }
      all.sort(
        (a: any, b: any) => +new Date(b.modified) - +new Date(a.modified),
      );
      const q = arg.toLowerCase();
      return (
        all.find((s: any) => s.id.toLowerCase() === q) ||
        (q.length >= 6
          ? all.find((s: any) => s.id.toLowerCase().startsWith(q))
          : undefined) ||
        all.find((s: any) => (s.name || "").toLowerCase().includes(q)) ||
        all.find((s: any) =>
          (s.firstMessage || "").toLowerCase().includes(q),
        ) ||
        null
      );
    } catch {
      return null;
    }
  }

  /**
   * 切换会话（唯一合法入口）：优先直调，必要时走命令通道，
   * 并在完成后校验会话是否真的切换（防止命令文本泄入 LLM 造成意外行为）。
   */
  async function performSwitch(targetPath: string) {
    if (typeof (currentCtx as any)?.switchSession === "function") {
      await (currentCtx as any).switchSession(targetPath);
      return;
    }
    await pi.sendUserMessage(
      [{ type: "text", text: `/feishubot-switch-session ${targetPath}` }],
      { expandPromptTemplates: true } as any,
    );
    // 校验：命令通道必须真正生效，否则抛错（绝不把 / 命令文本留给 LLM 发挥）
    await sleep(800);
    const cur = currentSessionFile();
    if (cur && cur !== targetPath) {
      throw new Error("会话切换未生效（命令通道未响应，已拦截）");
    }
  }

  // ========================================================================
  // 连接
  // ========================================================================

  function buildChannel(cfg: FeishuBotConfig) {
    // 注意：不传 domain！裸字符串 "feishu" 会导致 Invalid URL（SDK 期望完整 URL 或默认值）
    return createLarkChannel({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      transport: "websocket",
      // 从群成员 roster 解析发送者真实姓名（每个 chat 一次，带缓存；否则显示 ou_xxx）
      resolveSenderNames: true,
      policy: {
        requireMention: true, // 群聊必须 @Pi
        dmMode: "open", // 单聊全放行
      },
      safety: {
        chatQueue: { enabled: true, mergeWhileBusy: false },
        dedup: { ttl: 300_000 },
        staleMessageWindowMs: 10 * 60 * 1000,
      },
      loggerLevel: "warn",
      // WS 保活看门狗：连接僵死时自动强制重连
      keepalive: { enabled: true },
    });
  }

  async function connect(ctx: ExtensionContext): Promise<boolean> {
    currentCtx = ctx;
    const cfg = await loadConfig();
    if (!cfg) {
      ctx.ui.notify("飞书机器人未配置：/feishubot-add 添加凭据", "warning");
      return false;
    }

    disconnect();

    const delays = [0, 2000, 5000];
    let lastErr: any = null;
    for (const delay of delays) {
      if (delay > 0) await sleep(delay);
      // 每次尝试重建 channel（connect 失败后内部状态可能不干净）
      try {
        channel = buildChannel(cfg);
        attachChannelHandlers();
        await channel.connect();
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        const cause = e?.context?.cause || e?.cause;
        console.error(
          `[feishubot] connect 尝试失败 (code=${e?.code}): ${e?.message}`,
          cause ? `| cause: ${cause?.message || cause}` : "",
        );
        try {
          channel?.disconnect();
        } catch {}
        channel = null;
      }
    }

    if (lastErr || !channel) {
      connected = false;
      const cause = lastErr?.context?.cause || lastErr?.cause;
      const causeMsg = cause ? ` | 底层原因: ${cause?.message || cause}` : "";
      const msg =
        lastErr instanceof LarkChannelError
          ? `${lastErr.code}: ${lastErr.message}`
          : lastErr?.message || String(lastErr);
      console.error("[feishubot] connect 最终失败:", msg, causeMsg);
      ctx.ui.notify(`飞书连接失败: ${msg}${causeMsg}`, "error");
      return false;
    }

    connected = true;
    try {
      botName = channel.getBotIdentity()?.name || botName;
    } catch {}
    ctx.ui.notify(`✅ 飞书机器人已连接: ${botName}`, "info");
    console.log(`[feishubot] connected as ${botName}`);
    return true;
  }

  function attachChannelHandlers() {
    if (!channel) return;
    channel.on(
      "message",
      (msg: any) =>
        void handleFeishuMessage(msg).catch((e) =>
          console.error("[feishubot] handle message error:", e),
        ),
    );
    channel.on("error", (err: any) => {
      console.error(
        "[feishubot] channel error:",
        err?.code || "",
        err?.message || err,
      );
    });
    channel.on("reconnecting", () => console.log("[feishubot] WS 重连中..."));
    channel.on("reconnected", () => console.log("[feishubot] WS 已恢复"));
  }

  function disconnect() {
    if (channel) {
      try {
        channel.disconnect();
      } catch {}
      channel = null;
    }
    connected = false;
  }

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ========================================================================
  // 出站：普通回复（分段 + 降级）
  // ========================================================================

  async function replyMarkdown(req: FeishuRequest, md: string) {
    if (!channel) return;
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
        await channel.reply(target, { markdown: part });
      } catch {
        try {
          await channel.reply(target, { text: markdownToText(part) });
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

  async function sendToChat(chatId: string, md: string, threadId?: string) {
    if (!channel) return;
    const chunks = splitLongMarkdown(md);
    for (let i = 0; i < chunks.length; i++) {
      const part =
        chunks.length > 1
          ? `**[${i + 1}/${chunks.length}]** ${chunks[i]}`
          : chunks[i];
      try {
        await channel.send(
          chatId,
          { markdown: part },
          threadId ? { replyInThread: true } : undefined,
        );
      } catch {
        try {
          await channel.send(
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

  // ========================================================================
  // 流式打字机
  // ========================================================================

  /** 首个 text_delta 到达时建立流式卡片 + flush 定时器 */
  function ensureStream(req: FeishuRequest) {
    if (req.phase !== "thinking" || !channel) return;
    req.phase = "streaming";

    // 关键：producer 必须保持 pending 直到流真正结束。
    // SDK 的 run(producer) 在 producer resolve 时立即 completeTerminal() 完结卡片；
    // 若提前 resolve，后续 append 会触发 rollover 产生新卡片消息（多条中间消息的根源）。
    let resolveProducer!: () => void;
    const producer = (ctrl: any) => {
      req.streamCtrl = ctrl;
      // flush 循环：把 buffer 增量推给卡片
      req.streamFlushTimer = setInterval(async () => {
        if (req.finalized || !req.streamCtrl) return;
        const buf = req.streamBuffer;
        if (buf.length > req.streamAppended) {
          const chunk = buf.slice(req.streamAppended);
          req.streamAppended = buf.length;
          try {
            await req.streamCtrl.append(chunk);
          } catch {
            try {
              await req.streamCtrl.setContent(buf);
            } catch {}
          }
        }
      }, STREAM_FLUSH_MS);
      return new Promise<void>((resolve) => {
        resolveProducer = resolve;
        // Promise 执行器同步运行：这里赋值才能保证 finalize 拿到 resolve 函数
        (req as any).resolveProducer = resolve;
      });
    };

    void channel
      .stream(
        req.chatId,
        { markdown: producer },
        req.threadId ? { replyInThread: true } : undefined,
      )
      .catch((e: any) => {
        console.error(
          "[feishubot] stream 建立失败:",
          e?.code || "",
          e?.message || e,
        );
        // 流式失败 → 收尾时走普通回复
        req.streamCtrl = null;
        req.phase = req.phase === "streaming" ? "thinking" : req.phase;
      });
  }

  /** 定格流式卡片为最终全文；失败回落普通回复 */
  async function finalizeRequest(req: FeishuRequest, finalMd: string) {
    if (req.finalized) return;
    req.finalized = true;
    req.phase = "done";

    if (req.streamFlushTimer) {
      clearInterval(req.streamFlushTimer);
      req.streamFlushTimer = null;
    }

    if (req.streamCtrl) {
      let settled = false;
      try {
        await req.streamCtrl.setContent(finalMd);
        settled = true;
      } catch (e: any) {
        console.error(
          "[feishubot] setContent 失败，降级普通回复:",
          e?.message || e,
        );
      }
      // setContent 已入队节流器；release producer 让 SDK completeTerminal() 定格卡片。
      // 注意 SDK 的 throttle 是异步的， setContent 仅标记最大优先级，由节流器统一 flush。
      await sleep(300);
      const resolveProducer = (req as any).resolveProducer as
        | (() => void)
        | undefined;
      if (resolveProducer) {
        try {
          resolveProducer();
        } catch {}
        (req as any).resolveProducer = null;
      }
      if (!settled) {
        await replyMarkdown(req, finalMd);
      }
    } else {
      await replyMarkdown(req, finalMd);
    }

    requests.delete(req.messageId);
    if (activeRequest === req) activeRequest = null;
  }

  // ========================================================================
  // 快捷指令（零 token）
  // ========================================================================

  async function handleFastCommand(
    req: FeishuRequest,
    text: string,
  ): Promise<boolean> {
    const lower = text.trim().toLowerCase();
    const reply = (md: string) => replyMarkdown(req, md);

    if (lower === "帮助" || lower === "help" || lower === "/help") {
      await reply(
        [
          "### 🤖 Pi 飞书遥控指令",
          "",
          "**状态与控制**",
          "- `状态` / `/status` — 任务、工具、上下文占用",
          "- `停止` / `/stop` — 中断当前任务",
          "",
          "**会话管理**",
          "- `会话` / `sessions` — 列出最近会话",
          "- `切会话 <序号/ID/名称>` — 切换到指定会话",
          "- `绑定会话 <关键词>` — 本聊天固定路由到该会话",
          "- `解绑会话` — 解除路由绑定",
          "- `新会话` / `/new` — 重置会话上下文",
          "",
          "**模型管理**",
          "- `当前模型` / `/model` — 查看当前模型",
          "- `列出模型` / `/models` — 可用模型列表",
          "- `切换模型到 <名称>` — 即时切换",
          "",
          "**日常任务**",
          "- 直接发自然语言需求，Pi 自动执行并回传",
        ].join("\n"),
      );
      return true;
    }

    if (
      lower === "停止" ||
      lower === "中止" ||
      lower === "stop" ||
      lower === "/stop" ||
      lower === "/abort"
    ) {
      if (currentCtx && !currentCtx.isIdle()) {
        currentCtx.abort();
        await reply("🛑 已发送中止指令。");
      } else {
        await reply("○ 当前空闲，无运行中的任务。");
      }
      return true;
    }

    if (
      lower === "状态" ||
      lower === "进度" ||
      lower === "status" ||
      lower === "/status"
    ) {
      const busy = currentCtx ? !currentCtx.isIdle() : false;
      const model = currentCtx?.model;
      let usage = "未知";
      try {
        const u = currentCtx?.getContextUsage();
        if (u) {
          const pct = u.percent == null ? "?" : `${Math.round(u.percent)}%`;
          const toks = u.tokens == null ? "?" : u.tokens.toLocaleString();
          const win =
            u.contextWindow == null ? "?" : u.contextWindow.toLocaleString();
          usage = `${pct} (${toks} / ${win} tokens)`;
        }
      } catch {}
      const lines = [
        "### 🤖 Pi 运行状态",
        `- **状态**: ${busy ? "● 执行中" : "○ 空闲"}`,
        `- **模型**: \`${model?.id || "默认"}\` (${model?.provider || "未知"})`,
        `- **上下文**: ${usage}`,
        `- **工作目录**: \`${currentCtx?.cwd || process.cwd()}\``,
      ];
      if (busy && activeToolInfo) {
        const toolSec = Math.round(
          (Date.now() - activeToolInfo.startedAt) / 1000,
        );
        lines.push(
          `- **正在执行**: \`${activeToolInfo.name}\`${activeToolInfo.argsSummary ? ` (${activeToolInfo.argsSummary})` : ""} · ${toolSec}s`,
        );
      }
      await reply(lines.join("\n"));
      return true;
    }

    if (
      lower === "当前模型" ||
      lower === "查看模型" ||
      lower === "模型" ||
      lower === "/model"
    ) {
      const m = currentCtx?.model;
      await reply(
        `🤖 当前模型: **${m?.id || "默认"}** (${m?.provider || "未知"})\n切换: \`切换模型到 <名称>\``,
      );
      return true;
    }

    if (
      lower === "列出模型" ||
      lower === "可用模型" ||
      lower === "models" ||
      lower === "/models"
    ) {
      const all = currentCtx?.modelRegistry?.getAll?.() || [];
      const popular = all.filter((m: any) =>
        /gemini|glm|claude|deepseek|qwen|gpt|o1|o3/i.test(m.id),
      );
      const sample = (popular.length ? popular : all)
        .slice(0, 15)
        .map((m: any) => `- \`${m.id}\` (${m.provider})`)
        .join("\n");
      await reply(
        `### 📋 可用模型 (共 ${all.length})\n${sample}\n\n切换: \`切换模型到 <模型名>\``,
      );
      return true;
    }

    const sw = text.trim().match(MODEL_SWITCH_RE);
    if (sw && currentCtx?.modelRegistry) {
      const raw = sw[1].trim();
      const q = raw.replace(/\.+/g, ".").trim().toLowerCase();
      const all = currentCtx.modelRegistry.getAll();
      const matched =
        all.find((m: any) => m.id.toLowerCase() === q) ||
        all.find((m: any) => m.id.toLowerCase().includes(q)) ||
        all.find((m: any) => m.name?.toLowerCase().includes(q));
      if (matched) {
        const ok = await pi.setModel(matched);
        if (ok === false) {
          await reply(`❌ 模型切换失败: ${matched.id}`);
        } else {
          try {
            const settingsFile = join(
              homedir(),
              ".pi",
              "agent",
              "settings.json",
            );
            const s = JSON.parse(await readFile(settingsFile, "utf8"));
            s.defaultModel = matched.id;
            await writeFile(settingsFile, JSON.stringify(s, null, 2));
          } catch {}
          await reply(
            `✅ 模型已切换为 **${matched.id}** (${matched.provider})，已保存为默认。`,
          );
        }
      } else {
        await reply(`❌ 未找到模型 "${raw}"。试试 \`列出模型\`。`);
      }
      return true;
    }

    if (
      lower === "新会话" ||
      lower === "清空" ||
      lower === "/new" ||
      lower === "/clear"
    ) {
      try {
        if (typeof (currentCtx as any)?.newSession === "function") {
          await (currentCtx as any).newSession();
        } else {
          // 通过扩展命令分发通道触发，注入 CommandContext，零 token
          await pi.sendUserMessage(
            [{ type: "text", text: "/feishubot-new-session" }],
            { expandPromptTemplates: true } as any,
          );
        }
        await reply("✨ 已开启全新会话。");
      } catch (e: any) {
        await reply(`❌ 开启新会话失败: ${e?.message || e}`);
      }
      return true;
    }

    // 【会话列表】列出当前工作目录下最近的 pi 会话
    if (
      lower === "会话" ||
      lower === "会话列表" ||
      lower === "sessions" ||
      lower === "/sessions"
    ) {
      try {
        const { SessionManager } = await import(
          "@mariozechner/pi-coding-agent"
        );
        let list: any[] = [];
        try {
          list = await SessionManager.list(currentCtx?.cwd || process.cwd());
        } catch {}
        if (!list || list.length === 0) {
          list = await SessionManager.listAll();
        }
        list.sort(
          (a: any, b: any) => +new Date(b.modified) - +new Date(a.modified),
        );
        lastSessionList = list.slice(0, 10);
        if (lastSessionList.length === 0) {
          await reply("📂 还没有历史会话。发 `新会话` 或直接提需求即可。");
          return true;
        }
        // 并行提取会话中文名（用户未命名时取首条用户消息）
        const names = await Promise.all(
          lastSessionList.map((s: any) => sessionDisplayName(s)),
        );
        lastSessionList.forEach((s: any, i: number) => {
          s._displayName = names[i];
        });
        const cur =
          (currentCtx as any)?.sessionManager?.sessionPath ||
          (currentCtx as any)?.sessionManager?.sessionFile ||
          "";
        const lines = [`### 📋 最近会话 (共 ${lastSessionList.length} 个)`, ""];
        let seq = 0;
        for (const s of lastSessionList) {
          const i = seq++;
          const d = new Date(s.modified);
          const Y = d.getFullYear();
          const M = String(d.getMonth() + 1).padStart(2, "0");
          const D = String(d.getDate()).padStart(2, "0");
          const h = String(d.getHours()).padStart(2, "0");
          const m = String(d.getMinutes()).padStart(2, "0");
          const timeStr = `${Y}-${M}-${D} ${h}:${m}`;
          const title = s.name || s._displayName || s.id.slice(0, 8);
          const boundPath = chatBindings[req.chatId];
          const curMark = cur && s.path === cur ? "  *(当前会话)*" : "";
          const bindMark =
            boundPath && s.path === boundPath ? "  📍已绑定" : "";
          // 运行中判定：bot 自己所在会话一定运行中；其余看最近 5 分钟内有无写入
          const ACTIVE_MS = 5 * 60 * 1000;
          let mtimeMs = 0;
          try {
            mtimeMs = (await stat(s.path)).mtimeMs;
          } catch {}
          const activeMark =
            (cur && s.path === cur) || Date.now() - mtimeMs < ACTIVE_MS
              ? "  🟢运行中"
              : "";
          lines.push(
            `${i + 1}. **${title}**${curMark}${bindMark}`,
            `   • 会话ID: \`${s.id}\``,
            `   • 最近操作: ${timeStr}`,
            "",
          );
        }
        lines.push(
          "💡 **切换方式**：",
          "- 按序号：`切会话 1`",
          "- 按会话ID：`切会话 <会话ID>`（支持复制上方ID或前8位）",
          "- 按名称：`切会话 <名称关键词>`",
          "- 长期固定：`绑定会话 <关键词>`（本聊天消息自动路由）",
        );
        await reply(lines.join("\n"));
      } catch (e: any) {
        await reply(`❌ 无法列出会话: ${e?.message || e}`);
      }
      return true;
    }

    // 【切换会话】`切会话 <序号/会话ID/名称>` / `/session <id>`
    // 安全约束：任务执行中禁止切换（防止任务中断/会话意外漂移）；目标==当前时短路
    const swSession = text.trim().match(SESSION_SWITCH_RE);
    if (swSession) {
      const arg = swSession[1].trim();
      if (currentCtx && !currentCtx.isIdle()) {
        await reply(
          "⏳ 当前有任务执行中，禁止切换会话（防止任务中断）。可先发 `停止` 中止后再切。",
        );
        return true;
      }
      const target = await resolveSessionTarget(arg);
      if (!target) {
        await reply(
          `❌ 未找到匹配的会话 "${arg}"。可先发 \`会话\` 查看最近列表，或提供完整的会话ID。`,
        );
        return true;
      }
      const curFile = currentSessionFile();
      if (curFile && target.path === curFile) {
        await reply(
          `○ 已在会话 **${target.name || target.id.slice(0, 8)}** 中，无需切换。`,
        );
        return true;
      }
      const targetName =
        target.name ||
        target._displayName ||
        target.firstMessage?.slice(0, 20) ||
        target.id.slice(0, 8);
      try {
        await performSwitch(target.path);
        lastSessionList = [];
        const d = new Date(target.modified);
        const timeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        await reply(
          [
            `✅ **已成功切换到会话**`,
            `- **名称**: ${targetName}`,
            `- **会话ID**: \`${target.id}\``,
            `- **最近操作**: ${timeStr}`,
          ].join("\n"),
        );
      } catch (e: any) {
        await reply(`❌ 切换失败: ${e?.message || e}`);
      }
      return true;
    }

    // 【绑定会话】`绑定会话 <序号/ID/关键词>` —— 当前飞书聊天固定路由到该会话
    const bindSession = text.trim().match(SESSION_BIND_RE);
    if (bindSession) {
      const arg = bindSession[1].trim();
      const target = await resolveSessionTarget(arg);
      if (!target) {
        await reply(`❌ 未找到匹配的会话 "${arg}"。可先发 \`会话\` 查看列表。`);
        return true;
      }
      chatBindings[req.chatId] = target.path;
      await saveBindings();
      const targetName =
        target.name ||
        target._displayName ||
        target.firstMessage?.slice(0, 20) ||
        target.id.slice(0, 8);
      const curFile = currentSessionFile();
      const switchedNow =
        curFile && target.path !== curFile && currentCtx && currentCtx.isIdle();
      if (switchedNow) {
        try {
          await performSwitch(target.path);
          lastSessionList = [];
        } catch {}
      }
      await reply(
        [
          `📍 **已绑定路由**：本聊天 → 会话 **${targetName}**`,
          `- **会话ID**: \`${target.id}\``,
          switchedNow
            ? `- 已立即切换过去，现在发消息直达该会话`
            : `- 之后发消息自动路由到该会话（任务执行中会暂缓路由）`,
          `- 解除：发 \`解绑会话\``,
        ].join("\n"),
      );
      return true;
    }

    // 【解绑会话】恢复默认路由
    if (SESSION_UNBIND_RE.test(text.trim())) {
      if (chatBindings[req.chatId]) {
        delete chatBindings[req.chatId];
        await saveBindings();
        await reply("🔓 已解除本聊天的会话绑定，消息恢复进入当前所处会话。");
      } else {
        await reply("○ 本聊天没有绑定会话。");
      }
      return true;
    }

    return false;
    return false;
  }

  // ========================================================================
  // 入站消息
  // ========================================================================

  async function handleFeishuMessage(msg: any) {
    if (!connected || !pi) return;

    // bot 消息跳过（防回环）
    if (msg.senderIsBot) return;

    // 去重兜底
    if (seenMessages.has(msg.messageId)) return;
    seenMessages.add(msg.messageId);
    setTimeout(() => seenMessages.delete(msg.messageId), 10 * 60 * 1000);

    const text = (msg.content || "").trim();

    // 只 @ 不说话
    if (!text) {
      if (msg.mentionedBot) {
        await channel
          ?.reply(msg, { text: "👋 我在！直接说需求（发 `帮助` 查看指令）" })
          .catch(() => {});
      }
      return;
    }

    const req: FeishuRequest = {
      chatId: msg.chatId,
      messageId: msg.messageId,
      senderName: msg.senderName || msg.senderId || "用户",
      threadId: msg.threadId,
      phase: "thinking",
      streamCtrl: null,
      streamBuffer: "",
      streamFlushTimer: null,
      streamAppended: 0,
      finalized: false,
    };

    // 快捷指令：零 token 秒回
    if (isFastCommandText(text)) {
      const handled = await handleFastCommand(req, text);
      if (handled) return;
    }

    // 【会话路由】绑定表优先：本聊天绑定了会话且不是当前所处会话 → 自动路由过去
    const boundPath = chatBindings[req.chatId];
    if (boundPath && boundPath !== currentSessionFile()) {
      if (currentCtx && !currentCtx.isIdle()) {
        // 任务执行中绝不切换（保住正在跑的任务），给出明确提示
        await replyMarkdown(
          req,
          "⏳ 当前有任务执行中，本消息暂未路由到绑定会话。任务完成或发 `停止` 后重发即可。",
        );
        return;
      }
      try {
        await performSwitch(boundPath);
      } catch (e: any) {
        await replyMarkdown(req, `❌ 路由到绑定会话失败: ${e?.message || e}`);
        return;
      }
    }

    // 记录请求 + 注入 pi
    requests.set(req.messageId, req);
    activeRequest = req;

    const injectText = `[feishubot] [${req.senderName}] [${req.chatId}] [${req.messageId}]\n${text}`;
    try {
      // @ts-expect-error
      await pi.sendUserMessage([{ type: "text", text: injectText }], {
        deliverAs: "steer",
      });
    } catch (e) {
      console.error("[feishubot] 注入 pi 失败:", e);
      requests.delete(req.messageId);
      if (activeRequest === req) activeRequest = null;
      await replyMarkdown(req, "⚠️ 消息注入失败，请稍后重试。");
    }
  }

  // ========================================================================
  // pi 事件
  // ========================================================================

  // token 级流式 → 打字机卡片
  pi.on("message_update", (e) => {
    if (!connected) return;
    const msg = e.message as any;
    if (msg?.role !== "assistant") return;
    const evt = e.assistantMessageEvent;
    if (evt?.type !== "text_delta" || !evt.delta) return;

    const req = activeRequest;
    if (!req || req.finalized) return;
    req.streamBuffer += evt.delta;
    ensureStream(req);
  });

  pi.on("tool_execution_start", (e) => {
    activeToolInfo = {
      name: e.toolName,
      argsSummary: summarizeArgs(e.args),
      startedAt: Date.now(),
    };
  });

  pi.on("tool_execution_end", () => {
    activeToolInfo = null;
  });

  pi.on("before_agent_start", () => {
    activeToolInfo = null;
  });

  pi.on("agent_end", async (e) => {
    if (!connected) return;
    const messages = e.messages as any[];

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
      if (finalizedMessageIds.has(messageId)) continue;

      const req = requests.get(messageId);
      if (req && req.finalized) {
        finalizedMessageIds.add(messageId);
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

      // 3. 防早夭/防误报核心：
      // 大模型执行工具调用（如 bash/read/edit）期间，assistant 消息只含 toolCall，text 为空。
      // 若此时触发 agent_end（多 turn 切换时），如果 agent 还没真正空闲，绝不能提早定格！
      if (!content) {
        // 如果卡片在流式过程中已经缓冲了文本，优先采用流式 buffer
        if (req && req.streamBuffer && req.streamBuffer.trim()) {
          content = req.streamBuffer.trim();
        } else if (currentCtx && !currentCtx.isIdle()) {
          // 任务还在进行中（工具调用中），静默等待后续轮次产出文本
          continue;
        }
      }

      // 4. 如果任务确实彻底结束，但依然没有任何文本：
      if (!content) {
        if (!req) {
          // 历史孤儿消息，坚决不向飞书补发无意义的告警
          finalizedMessageIds.add(messageId);
          continue;
        }
        content = "⚠️ 任务已结束，但未产生回复文本。";
      }

      // 5. 正式定格或发送
      finalizedMessageIds.add(messageId);
      if (req) {
        await finalizeRequest(req, content);
      } else {
        // 仅当从未处理过且确实有新文本产生时，才向会话兜底发送
        await sendToChat(chatId, content);
      }
    }
  });

  // ========================================================================
  // 生命周期
  // ========================================================================

  pi.on("session_start", async (_e, ctx) => {
    currentCtx = ctx;
    if (!SDK) return;
    await loadBindings();
    const cfg = await loadConfig();
    if (cfg) {
      await connect(ctx);
    } else {
      console.log(
        "[feishubot] 未配置，跳过连接（/feishubot-add 或 npm 脚本注册）",
      );
    }
  });

  pi.on("session_shutdown", () => {
    for (const req of requests.values()) {
      req.finalized = true;
      if (req.streamFlushTimer) clearInterval(req.streamFlushTimer);
    }
    requests.clear();
    activeRequest = null;
    disconnect();
  });

  // ========================================================================
  // 命令
  // ========================================================================

  pi.registerCommand("feishubot-add", {
    description: "添加飞书机器人凭据",
    handler: async (_args, ctx) => {
      const appId = await ctx.ui.input("飞书 App ID (cli_ 开头)", "");
      if (!appId) return;
      const appSecret = await ctx.ui.input("飞书 App Secret", "");
      if (!appSecret) return;
      await saveConfig({ appId: appId.trim(), appSecret: appSecret.trim() });
      ctx.ui.notify("✅ 凭据已保存，正在连接...", "info");
      await connect(ctx);
    },
  });

  pi.registerCommand("feishubot-remove", {
    description: "删除飞书机器人配置",
    handler: async (_args, ctx) => {
      if (!(await ctx.ui.confirm("确认删除飞书机器人配置？"))) return;
      await deleteConfig();
      disconnect();
      ctx.ui.notify("✅ 已删除", "info");
    },
  });

  pi.registerCommand("feishubot-reconnect", {
    description: "重新连接飞书",
    handler: async (_args, ctx) => {
      await connect(ctx);
    },
  });

  pi.registerCommand("feishubot-status", {
    description: "查看飞书机器人状态",
    handler: async (_args, ctx) => {
      const cfg = await loadConfig();
      if (!cfg) {
        ctx.ui.notify("飞书机器人: ❌ 未配置（/feishubot-add）", "info");
        return;
      }
      ctx.ui.notify(
        `飞书机器人: ${connected ? "✅ 已连接" : "❌ 未连接"}\nBot: ${botName}\nAppID: ${cfg.appId}`,
        "info",
      );
    },
  });

  // 内部命令：由 pi 核心以 ExtensionCommandContext 执行，具备 switchSession 与 newSession 权限
  pi.registerCommand("feishubot-switch-session", {
    description: "飞书内部会话切换通道",
    handler: async (args, cmdCtx) => {
      const sessionPath = args.trim();
      if (!sessionPath) return;
      if (typeof cmdCtx.switchSession === "function") {
        await cmdCtx.switchSession(sessionPath);
      }
    },
  });

  pi.registerCommand("feishubot-new-session", {
    description: "飞书内部新建会话通道",
    handler: async (_args, cmdCtx) => {
      if (typeof cmdCtx.newSession === "function") {
        await cmdCtx.newSession();
      }
    },
  });
}
