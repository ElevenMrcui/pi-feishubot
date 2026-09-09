/**
 * commands/instances.ts — Command 模式：实例生命周期指令
 * （实例列表 / 启动实例 / 恢复会话 / 关闭实例）
 *
 * instances 标记 localOnly：注册表是网关级全局视图。
 */
import { existsSync } from "node:fs";
import type { BotRuntime, FastCommand } from "../types.ts";
import { replyMarkdown } from "../sender.ts";
import { readBindings } from "../storage.ts";
import {
  KILL_INSTANCE_RE,
  RESUME_CMD_RE,
  SPAWN_INSTANCE_RE,
  MAX_INSTANCES,
  homeRelativeJoin,
} from "../utils.ts";
import {
  electGateway,
  findInstanceByTag,
  listLiveInstances,
  waitNewInstance,
} from "../instances.ts";
import { resolveSessionTarget, spawnGhosttyPi } from "../session-control.ts";

// ---------------------------------------------------------------- 实例列表

export function createInstancesCommand(rt: BotRuntime): FastCommand {
  return {
    name: "instances",
    localOnly: true,
    match: (_text, lower) =>
      lower === "实例" || lower === "instances" || lower === "实例列表",
    async execute(req) {
      const live = await listLiveInstances(rt);
      const bindings = await readBindings();
      const lines = [`### 🖥 运行中的 Pi 实例 (共 ${live.length})`, ""];
      live.forEach((inst, i) => {
        const up = Math.round((Date.now() - inst.startedAt) / 60000);
        const upStr =
          up >= 60 ? `${Math.floor(up / 60)}h${up % 60}m` : `${up}m`;
        const gw = electGateway(live);
        const role = gw && gw.pid === inst.pid ? " · 🌐网关" : "";
        const selfMark = inst.pid === rt.SELF_PID ? " *(本实例)*" : "";
        const bindChat = Object.entries(bindings)
          .filter(([, p]) => p === inst.sessionFile)
          .map(([c]) => c.slice(0, 10) + "…");
        lines.push(
          `${i + 1}. **${inst.sessionName || inst.sessionFile.split("/").pop()?.slice(0, 30) || "未命名"}**${selfMark}`,
          `   • PID: ${inst.pid} · 运行 ${upStr}${role}`,
          `   • 目录: \`${inst.cwd}\``,
          bindChat.length ? `   • 绑定聊天: ${bindChat.join(", ")}` : "",
          "",
        );
      });
      lines.push(
        "💡 发消息时按 绑定表 路由到对应实例执行；未绑定的进网关当前会话。",
      );
      await replyMarkdown(
        rt,
        req,
        lines
          .filter((x) => x !== "")
          .join("\n")
          .replace(" ,", ",")
          .replace("\n\n\n", "\n\n"),
      );
      return true;
    },
  };
}

// ---------------------------------------------------------------- 启动实例

export function createSpawnInstanceCommand(rt: BotRuntime): FastCommand {
  return {
    name: "spawn-instance",
    match: (text) => SPAWN_INSTANCE_RE.test(text.trim()),
    async execute(req, text) {
      const spawnMatch = text.trim().match(SPAWN_INSTANCE_RE)!;
      const rawDir = homeRelativeJoin(spawnMatch[1]);
      const resume = Boolean(spawnMatch[2]);
      const dir = rawDir;
      if (!existsSync(dir)) {
        await replyMarkdown(rt, req, `❌ 目录不存在: ${dir}`);
        return true;
      }
      const live = await listLiveInstances(rt);
      if (live.length >= MAX_INSTANCES) {
        await replyMarkdown(
          rt,
          req,
          `❌ 实例数已达上限（${MAX_INSTANCES}）。先发 \`实例\` 查看，用 \`关闭实例 <PID>\` 释放。`,
        );
        return true;
      }
      const dirTag = dir.split("/").filter(Boolean).pop() || dir;
      // 若该目录已有存活实例 → 提示直接用 @标签 对话
      const existing = await findInstanceByTag(rt, dirTag);
      if (existing) {
        await replyMarkdown(
          rt,
          req,
          `○ 该目录已有运行中的实例（PID ${existing.pid}），直接发 \`@${dirTag} <消息>\` 即可对话。`,
        );
        return true;
      }
      await replyMarkdown(
        rt,
        req,
        `🚀 正在 Ghostty 新窗口启动 pi…\n- 目录: \`${dir}\`\n- 模式: ${resume ? "恢复最近会话" : "全新会话"}`,
      );
      try {
        await spawnGhosttyPi(dir, resume);
        const known = new Set(live.map((x) => x.pid));
        const fresh = await waitNewInstance(rt, known);
        if (fresh) {
          await replyMarkdown(
            rt,
            req,
            [
              `✅ **实例已上线**`,
              `- **PID**: ${fresh.pid}`,
              `- **对话**: 发 \`@${dirTag} <消息>\` 路由到它`,
            ].join("\n"),
          );
        } else {
          await replyMarkdown(
            rt,
            req,
            "⚠️ Ghostty 窗口已打开，20s 内未检测到实例注册（可能在加载大会话），稍后发 `实例` 查看。",
          );
        }
      } catch (e: any) {
        await replyMarkdown(rt, req, `❌ 启动失败: ${e?.message || e}`);
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------- 恢复会话

export function createResumeSessionCommand(rt: BotRuntime): FastCommand {
  return {
    name: "resume-session",
    match: (text) => RESUME_CMD_RE.test(text.trim()),
    async execute(req, text) {
      const resumeCmd = text.trim().match(RESUME_CMD_RE)!;
      const kw = resumeCmd[1].trim();
      const target = await resolveSessionTarget(rt, kw);
      if (!target) {
        await replyMarkdown(
          rt,
          req,
          `❌ 未找到匹配的会话 "${kw}"。可先发 \`会话\` 查看列表。`,
        );
        return true;
      }
      const live = await listLiveInstances(rt);
      if (live.length >= MAX_INSTANCES) {
        await replyMarkdown(rt, req, `❌ 实例数已达上限（${MAX_INSTANCES}）`);
        return true;
      }
      // 已有实例承载该会话 → 提示直接用
      const existing = live.find((x) => x.sessionFile === target.path);
      if (existing) {
        await replyMarkdown(
          rt,
          req,
          `○ 该会话已在实例 PID ${existing.pid} 上运行，直接发 \`@<标签> <消息>\` 即可。`,
        );
        return true;
      }
      const sessName = target.name || target.id.slice(0, 8);
      await replyMarkdown(
        rt,
        req,
        `🚀 正在 Ghostty 新窗口恢复会话 **${sessName}**…`,
      );
      try {
        await spawnGhosttyPi(target.cwd || process.cwd(), true);
        const known = new Set(live.map((x) => x.pid));
        const fresh = await waitNewInstance(rt, known);
        if (fresh) {
          await replyMarkdown(
            rt,
            req,
            `✅ **会话已在新窗口恢复**（PID ${fresh.pid}），稍后即可对话。`,
          );
        } else {
          await replyMarkdown(
            rt,
            req,
            "⚠️ 窗口已打开，实例注册稍后完成，可发 `实例` 查看。",
          );
        }
      } catch (e: any) {
        await replyMarkdown(rt, req, `❌ 恢复失败: ${e?.message || e}`);
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------- 关闭实例

export function createKillInstanceCommand(rt: BotRuntime): FastCommand {
  return {
    name: "kill-instance",
    match: (text) => KILL_INSTANCE_RE.test(text.trim()),
    async execute(req, text) {
      const killMatch = text.trim().match(KILL_INSTANCE_RE)!;
      const pid = parseInt(killMatch[1], 10);
      if (pid === rt.SELF_PID) {
        await replyMarkdown(
          rt,
          req,
          "❌ 不能关闭自己（这是当前对话所在实例）。",
        );
        return true;
      }
      const live = await listLiveInstances(rt);
      const target = live.find((x) => x.pid === pid);
      if (!target) {
        await replyMarkdown(
          rt,
          req,
          `❌ 未找到 PID ${pid} 对应的运行中实例。发 \`实例\` 查看。`,
        );
        return true;
      }
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        execFile("kill", [String(pid)], () => resolve());
      });
      await replyMarkdown(
        rt,
        req,
        `🛑 已发送终止信号到 PID ${pid}（${target.sessionName || target.cwd}）。`,
      );
      return true;
    },
  };
}
