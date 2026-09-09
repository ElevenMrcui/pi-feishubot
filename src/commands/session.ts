/**
 * commands/session.ts — Command 模式：会话管理指令
 * （会话列表 / 切会话 / 绑定会话 / 解绑会话）
 *
 * sessions/bind/unbind 标记 localOnly：绑定表与列表查询是网关级全局操作。
 */
// @ts-nocheck
import { stat } from "node:fs/promises";
import type { BotRuntime, FastCommand } from "../types.ts";
import { replyMarkdown } from "../sender.ts";
import { readBindings, saveBindings } from "../storage.ts";
import {
  SESSION_BIND_RE,
  SESSION_SWITCH_RE,
  SESSION_UNBIND_RE,
  sessionDisplayName,
} from "../utils.ts";
import { findInstanceBySession, currentSessionFile } from "../instances.ts";
import { performSwitch, resolveSessionTarget } from "../session-control.ts";

// ---------------------------------------------------------------- 会话列表

export function createSessionsCommand(rt: BotRuntime): FastCommand {
  return {
    name: "sessions",
    localOnly: true,
    match: (_text, lower) =>
      lower === "会话" ||
      lower === "会话列表" ||
      lower === "sessions" ||
      lower === "/sessions",
    async execute(req) {
      try {
        const pkg = "@mariozechner/pi-coding-agent";
        const { SessionManager } = await import(pkg);
        let list: any[] = [];
        try {
          list = await SessionManager.list(rt.currentCtx?.cwd || process.cwd());
        } catch (e) {
          void e; // 工作目录列表失败 → 回落全量
        }
        if (!list || list.length === 0) {
          list = await SessionManager.listAll();
        }
        list.sort(
          (a: any, b: any) => +new Date(b.modified) - +new Date(a.modified),
        );
        rt.lastSessionList = list.slice(0, 10);
        if (rt.lastSessionList.length === 0) {
          await replyMarkdown(
            rt,
            req,
            "📂 还没有历史会话。发 `新会话` 或直接提需求即可。",
          );
          return true;
        }
        // 并行提取会话中文名（用户未命名时取首条用户消息）
        const names = await Promise.all(
          rt.lastSessionList.map((s: any) => sessionDisplayName(s)),
        );
        rt.lastSessionList.forEach((s: any, i: number) => {
          s._displayName = names[i];
        });
        const sm = rt.currentCtx?.sessionManager;
        const cur = sm?.sessionPath || sm?.sessionFile || "";
        const lines = [
          `### 📋 最近会话 (共 ${rt.lastSessionList.length} 个)`,
          "",
        ];
        let seq = 0;
        for (const s of rt.lastSessionList) {
          const i = seq++;
          const d = new Date(s.modified);
          const Y = d.getFullYear();
          const M = String(d.getMonth() + 1).padStart(2, "0");
          const D = String(d.getDate()).padStart(2, "0");
          const h = String(d.getHours()).padStart(2, "0");
          const m = String(d.getMinutes()).padStart(2, "0");
          const timeStr = `${Y}-${M}-${D} ${h}:${m}`;
          const title = s.name || s._displayName || s.id.slice(0, 8);
          const boundPath = rt.chatBindings[req.chatId];
          const curMark = cur && s.path === cur ? "  *(当前会话)*" : "";
          const bindMark =
            boundPath && s.path === boundPath ? "  📍已绑定" : "";
          // 运行中判定：bot 自己所在会话一定运行中；其余看最近 5 分钟内有无写入
          const ACTIVE_MS = 5 * 60 * 1000;
          let mtimeMs = 0;
          try {
            mtimeMs = (await stat(s.path)).mtimeMs;
          } catch (e) {
            void e; // stat 失败 → 视为不活跃
          }
          const activeMark =
            (cur && s.path === cur) || Date.now() - mtimeMs < ACTIVE_MS
              ? "  🟢运行中"
              : "";
          lines.push(
            `${i + 1}. **${title}**${curMark}${bindMark}${activeMark}`,
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
        await replyMarkdown(rt, req, lines.join("\n"));
      } catch (e: any) {
        await replyMarkdown(rt, req, `❌ 无法列出会话: ${e?.message || e}`);
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------- 切换会话

export function createSwitchSessionCommand(
  rt: BotRuntime,
  pi: any,
): FastCommand {
  return {
    name: "switch-session",
    match: (text) => SESSION_SWITCH_RE.test(text.trim()),
    async execute(req, text) {
      const swSession = text.trim().match(SESSION_SWITCH_RE)!;
      const arg = swSession[1].trim();
      // 安全约束：任务执行中禁止切换（防止任务中断/会话意外漂移）
      if (rt.currentCtx && !rt.currentCtx.isIdle()) {
        await replyMarkdown(
          rt,
          req,
          "⏳ 当前有任务执行中，禁止切换会话（防止任务中断）。可先发 `停止` 中止后再切。",
        );
        return true;
      }
      const target = await resolveSessionTarget(rt, arg);
      if (!target) {
        await replyMarkdown(
          rt,
          req,
          `❌ 未找到匹配的会话 "${arg}"。可先发 \`会话\` 查看最近列表，或提供完整的会话ID。`,
        );
        return true;
      }
      const curFile = currentSessionFile(rt);
      if (curFile && target.path === curFile) {
        await replyMarkdown(
          rt,
          req,
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
        await performSwitch(rt, pi, target.path);
        rt.lastSessionList = [];
        const d = new Date(target.modified);
        const timeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        await replyMarkdown(
          rt,
          req,
          [
            `✅ **已成功切换到会话**`,
            `- **名称**: ${targetName}`,
            `- **会话ID**: \`${target.id}\``,
            `- **最近操作**: ${timeStr}`,
          ].join("\n"),
        );
      } catch (e: any) {
        await replyMarkdown(rt, req, `❌ 切换失败: ${e?.message || e}`);
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------- 绑定会话

export function createBindSessionCommand(rt: BotRuntime): FastCommand {
  return {
    name: "bind-session",
    localOnly: true,
    match: (text) => SESSION_BIND_RE.test(text.trim()),
    async execute(req, text) {
      const bindSession = text.trim().match(SESSION_BIND_RE)!;
      const arg = bindSession[1].trim();
      const target = await resolveSessionTarget(rt, arg);
      if (!target) {
        await replyMarkdown(
          rt,
          req,
          `❌ 未找到匹配的会话 "${arg}"。可先发 \`会话\` 查看列表。`,
        );
        return true;
      }
      rt.chatBindings[req.chatId] = target.path;
      await saveBindings({
        chats: rt.chatBindings,
        senders: rt.senderBindings,
      });
      const targetName =
        target.name ||
        target._displayName ||
        target.firstMessage?.slice(0, 20) ||
        target.id.slice(0, 8);
      const inst = await findInstanceBySession(rt, target.path);
      const instLine = inst
        ? `- 承载实例: PID ${inst.pid}${inst.pid === rt.SELF_PID ? "（本实例）" : ""}`
        : `- ⚠️ 该会话当前没有运行中的 Pi（启动后自动加入路由）`;
      await replyMarkdown(
        rt,
        req,
        [
          `📍 **已绑定路由**：本聊天 → 会话 **${targetName}**`,
          `- **会话ID**: \`${target.id}\``,
          instLine,
          `- 之后本聊天的消息自动路由到该会话执行，回传结果到本聊天`,
          `- 解除：发 \`解绑会话\``,
        ].join("\n"),
      );
      return true;
    },
  };
}

// ---------------------------------------------------------------- 解绑会话

export function createUnbindSessionCommand(rt: BotRuntime): FastCommand {
  return {
    name: "unbind-session",
    localOnly: true,
    match: (text) => SESSION_UNBIND_RE.test(text.trim()),
    async execute(req) {
      if (rt.chatBindings[req.chatId]) {
        delete rt.chatBindings[req.chatId];
        await saveBindings({
          chats: rt.chatBindings,
          senders: rt.senderBindings,
        });
        await replyMarkdown(
          rt,
          req,
          "🔓 已解除本聊天的会话绑定，消息恢复进入当前所处会话。",
        );
      } else {
        await replyMarkdown(rt, req, "○ 本聊天没有绑定会话。");
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------- 绑定我（发送方级）

/**
 * `绑定我 <关键词>` —— 群聊里只把「我」的消息路由到指定会话。
 * 同一群不同成员可各绑各的会话（发送方级三元绑定），互不影响聊天级绑定。
 */
export function createBindMeCommand(rt: BotRuntime): FastCommand {
  return {
    name: "bind-me",
    localOnly: true,
    match: (text) => SESSION_BIND_ME_RE.test(text.trim()),
    async execute(req, text) {
      const bindMe = text.trim().match(SESSION_BIND_ME_RE)!;
      const arg = bindMe[1].trim();
      const target = await resolveSessionTarget(rt, arg);
      if (!target) {
        await replyMarkdown(
          rt,
          req,
          `❌ 未找到匹配的会话 "${arg}"。可先发 \`会话\` 查看列表。`,
        );
        return true;
      }
      const senderKey = `${req.chatId}|${req.senderId || ""}`;
      rt.senderBindings[senderKey] = target.path;
      await saveBindings({
        chats: rt.chatBindings,
        senders: rt.senderBindings,
      });
      const targetName =
        target.name ||
        target._displayName ||
        target.firstMessage?.slice(0, 20) ||
        target.id.slice(0, 8);
      const inst = await findInstanceBySession(rt, target.path);
      const instLine = inst
        ? `- 承载实例: PID ${inst.pid}${inst.pid === rt.SELF_PID ? "（本实例）" : ""}`
        : `- ⚠️ 该会话当前没有运行中的 Pi（启动后自动加入路由）`;
      await replyMarkdown(
        rt,
        req,
        [
          `📍 **已绑定（发送方级）**：${req.senderName} 在本聊天 → 会话 **${targetName}**`,
          `- **会话ID**: \`${target.id}\``,
          instLine,
          `- 之后仅「你」在本聊天的消息路由到该会话，其他人不受影响`,
          `- 实例重启恢复同一会话后自动重新接上`,
          `- 解除：发 \`解绑我\``,
        ].join("\n"),
      );
      return true;
    },
  };
}

// ---------------------------------------------------------------- 解绑我

export function createUnbindMeCommand(rt: BotRuntime): FastCommand {
  return {
    name: "unbind-me",
    localOnly: true,
    match: (text) => SESSION_UNBIND_ME_RE.test(text.trim()),
    async execute(req) {
      const senderKey = `${req.chatId}|${req.senderId || ""}`;
      if (rt.senderBindings[senderKey]) {
        delete rt.senderBindings[senderKey];
        await saveBindings({
          chats: rt.chatBindings,
          senders: rt.senderBindings,
        });
        await replyMarkdown(
          rt,
          req,
          "🔓 已解除你的发送方级绑定，恢复聊天级/默认路由。",
        );
      } else {
        await replyMarkdown(rt, req, "○ 你在本聊天没有发送方级绑定。");
      }
      return true;
    },
  };
}
