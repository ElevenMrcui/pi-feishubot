/**
 * commands/basic.ts — Command 模式：基础指令（帮助 / 状态 / 停止 / 新会话）
 *
 * 每个指令实现 FastCommand 接口（match + execute），
 * 由 registry 统一编排；异常由 registry 统一兜底回执。
 */
import type { BotRuntime, FastCommand } from "../types.ts";
import { replyMarkdown } from "../sender.ts";

// ---------------------------------------------------------------- 帮助

export function createHelpCommand(rt: BotRuntime): FastCommand {
  return {
    name: "help",
    match: (_text, lower) =>
      lower === "帮助" || lower === "help" || lower === "/help",
    async execute(req) {
      await replyMarkdown(
        rt,
        req,
        [
          "### 🤖 Pi 飞书遥控指令",
          "",
          "**任务与状态**",
          "- `状态` / `/status` — 运行状态、工具、上下文占用",
          "- `停止` / `/stop` — 中断当前任务",
          "- 直接发送自然语言需求即可",
          "",
          "**模型**",
          "- `当前模型` — 查看当前模型",
          "- `列出模型` / `全部模型` — 已登录模型（表格）",
          "- `切换模型到 <名称>` — 即时切换",
          "",
          "**会话与实例**",
          "- `会话` / `切会话 <序号或关键词>` — 会话列表与切换",
          "- `绑定会话 <关键词>` / `解绑会话` — 聊天路由绑定",
          "- `实例` — 运行中的 Pi 实例",
          "- `@<标签> <消息>` — 单条消息路由到指定实例",
          "- `启动实例 <目录> [恢复]` / `恢复会话 <关键词>` / `关闭实例 <pid>`",
          "- `重载` — 重载当前实例扩展",
        ].join("\n"),
      );
      return true;
    },
  };
}

// ---------------------------------------------------------------- 停止

export function createStopCommand(rt: BotRuntime): FastCommand {
  return {
    name: "stop",
    match: (_text, lower) =>
      lower === "停止" ||
      lower === "中止" ||
      lower === "stop" ||
      lower === "/stop" ||
      lower === "/abort",
    async execute(req) {
      if (rt.currentCtx && !rt.currentCtx.isIdle()) {
        rt.currentCtx.abort();
        await replyMarkdown(rt, req, "🛑 已发送中止指令。");
      } else {
        await replyMarkdown(rt, req, "○ 当前空闲，无运行中的任务。");
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------- 状态

export function createStatusCommand(rt: BotRuntime): FastCommand {
  return {
    name: "status",
    match: (_text, lower) =>
      lower === "状态" ||
      lower === "进度" ||
      lower === "status" ||
      lower === "/status",
    async execute(req) {
      const busy = rt.currentCtx ? !rt.currentCtx.isIdle() : false;
      const model = rt.currentCtx?.model;
      let usage = "未知";
      try {
        const u = rt.currentCtx?.getContextUsage();
        if (u) {
          const pct = u.percent == null ? "?" : `${Math.round(u.percent)}%`;
          const toks = u.tokens == null ? "?" : u.tokens.toLocaleString();
          const win =
            u.contextWindow == null ? "?" : u.contextWindow.toLocaleString();
          usage = `${pct} (${toks} / ${win} tokens)`;
        }
      } catch (e) {
        void e; // usage 不可用 → 显示未知
      }
      const lines = [
        "### 🤖 Pi 运行状态",
        `- **状态**: ${busy ? "● 执行中" : "○ 空闲"}`,
        `- **模型**: \`${model?.id || "默认"}\` (${model?.provider || "未知"})`,
        `- **上下文**: ${usage}`,
        `- **工作目录**: \`${rt.currentCtx?.cwd || process.cwd()}\``,
        `- **实例角色**: PID ${rt.SELF_PID} ${rt.isGateway ? "· 🌐网关(接飞书)" : "· 工作节点(收路由)"}`,
      ];
      if (busy && rt.activeToolInfo) {
        const toolSec = Math.round(
          (Date.now() - rt.activeToolInfo.startedAt) / 1000,
        );
        lines.push(
          `- **正在执行**: \`${rt.activeToolInfo.name}\`${rt.activeToolInfo.argsSummary ? ` (${rt.activeToolInfo.argsSummary})` : ""} · ${toolSec}s`,
        );
      }
      await replyMarkdown(rt, req, lines.join("\n"));
      return true;
    },
  };
}

// ---------------------------------------------------------------- 新会话

export function createNewSessionCommand(rt: BotRuntime, pi: any): FastCommand {
  return {
    name: "new-session",
    match: (_text, lower) =>
      lower === "新会话" ||
      lower === "清空" ||
      lower === "/new" ||
      lower === "/clear",
    async execute(req) {
      try {
        if (typeof rt.currentCtx?.newSession === "function") {
          await rt.currentCtx.newSession();
        } else {
          // 通过扩展命令分发通道触发，注入 CommandContext，零 token
          await pi.sendUserMessage(
            [{ type: "text", text: "/feishubot-new-session" }],
            { expandPromptTemplates: true } as any,
          );
        }
        await replyMarkdown(rt, req, "✨ 已开启全新会话。");
      } catch (e: any) {
        await replyMarkdown(rt, req, `❌ 开启新会话失败: ${e?.message || e}`);
      }
      return true;
    },
  };
}
