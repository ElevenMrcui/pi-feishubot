/**
 * session-control.ts — 会话目标解析与切换（含 Ghostty 实例生命周期）
 *
 * 安全约束：
 * - performSwitch 优先直调 ctx.switchSession，必要时走命令通道，
 *   并校验会话是否真的切换（防止命令文本泄入 LLM 造成意外行为）
 */
import { homedir } from "node:os";
import type { BotRuntime } from "./types.ts";
import { sleep } from "./utils.ts";
import { currentSessionFile } from "./instances.ts";

/**
 * 解析会话目标：序号（最近列表）→ 精确 ID → ID 前缀（≥6 位）→ 名称 → 首条消息关键词。
 * 全量库实时检索，模糊匹配按最近修改优先。
 */
export async function resolveSessionTarget(
  rt: BotRuntime,
  arg: string,
): Promise<any | null> {
  // 自由文本归一化：从任意输入中提取会话 ID（UUID）或其前缀，
  // 兼容「绑定会话 会话 ID: 01a07c38-…」「切会话 id=01a07c38」等口语化输入
  const uuidMatch = arg.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
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
  if (rt.lastSessionList && idx >= 0 && idx < rt.lastSessionList.length) {
    return rt.lastSessionList[idx];
  }
  try {
    // 变量间接引用：避免静态解析器报 Cannot find module（运行时由 pi 的 jiti virtualModules 解析）
    const pkg = "@mariozechner/pi-coding-agent";
    const { SessionManager } = await import(pkg);
    let all: any[] = [];
    try {
      all = await SessionManager.list(rt.currentCtx?.cwd || process.cwd());
    } catch (e) {
      void e; // 工作目录列表失败 → 回落全量
    }
    if (!all || all.length === 0) {
      all = await SessionManager.listAll();
    }
    all.sort((a: any, b: any) => +new Date(b.modified) - +new Date(a.modified));
    const q = arg.toLowerCase();
    return (
      all.find((s: any) => s.id.toLowerCase() === q) ||
      (q.length >= 6
        ? all.find((s: any) => s.id.toLowerCase().startsWith(q))
        : undefined) ||
      all.find((s: any) => (s.name || "").toLowerCase().includes(q)) ||
      all.find((s: any) => (s.firstMessage || "").toLowerCase().includes(q)) ||
      null
    );
  } catch (e) {
    void e; // SessionManager 不可用 → 无法解析
    return null;
  }
}

/**
 * 切换会话（唯一合法入口）：优先直调，必要时走命令通道，
 * 并在完成后校验会话是否真的切换（防止命令文本泄入 LLM 造成意外行为）。
 */
export async function performSwitch(
  rt: BotRuntime,
  pi: any,
  targetPath: string,
) {
  if (typeof rt.currentCtx?.switchSession === "function") {
    await rt.currentCtx.switchSession(targetPath);
    return;
  }
  await pi.sendUserMessage(
    [{ type: "text", text: `/feishubot-switch-session ${targetPath}` }],
    { expandPromptTemplates: true } as any,
  );
  // 校验：命令通道必须真正生效，否则抛错（绝不把 / 命令文本留给 LLM 发挥）
  await sleep(800);
  const cur = currentSessionFile(rt);
  if (cur && cur !== targetPath) {
    throw new Error("会话切换未生效（命令通道未响应，已拦截）");
  }
}

// ---------------- 远程实例生命周期（Ghostty 启动/关闭） ----------------

/** 在 Ghostty 新窗口启动 pi（目录 + 可选恢复模式） */
export async function spawnGhosttyPi(
  dir: string,
  resume: boolean,
): Promise<void> {
  const inner = resume ? "pi -r" : "pi";
  const cmd = `cd "${dir}" && ${inner}`;
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile("open", ["-na", "Ghostty.app", "--args", "-e", cmd], (err) => {
      if (err) reject(new Error("Ghostty 启动失败: " + err.message));
      else resolve();
    });
  });
}

export function expandHome(dir: string): string {
  return dir.replace(/^~/, homedir());
}
