/**
 * utils.ts — 纯函数工具集（无状态，可直接单测）
 */
import { open } from "node:fs/promises";
import { homedir } from "node:os";

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- 指令正则（Command 模式的匹配契约；命令实现引用这些常量） ----

/** reload 常见错拼容错（rwload/relaod/rewload…） */
export const RELOAD_RE =
  /^\/?(reload(es|ed|s?)|rwload|relaod|rewload|relode)$/i;
/** 切换会话：`切会话 3` / `切会话 <session文件名或id片段>` / `/session 3` / `/sessions 3` */
export const SESSION_SWITCH_RE = /^(?:切会话|切换会话|\/sessions?)\s+(.+)$/i;
/** 会话路由绑定：`绑定会话 <序号/ID/关键词>`（聊天级：整个聊天的消息都路由） */
export const SESSION_BIND_RE = /^(?:绑定会话|会话绑定|bind)\s+(.+)$/i;
/** 解除绑定：`解绑会话` */
export const SESSION_UNBIND_RE = /^(?:解绑会话|unbind)$/i;
/** 发送方级绑定：`绑定我 <关键词>` —— 群里只把「我」的消息路由到指定会话 */
export const SESSION_BIND_ME_RE = /^(?:绑定我|bind\s*me)\s+(.+)$/i;
/** 解除发送方级绑定：`解绑我` */
export const SESSION_UNBIND_ME_RE = /^(?:解绑我|unbind\s*me)$/i;
/** 启动实例：`启动实例 <目录> [恢复]` */
export const SPAWN_INSTANCE_RE =
  /^(?:启动实例|new\s+inst?)\s+(\S+)(?:\s+(恢复))?$/i;
/** 恢复会话：`恢复会话 <会话ID/关键词>` */
export const RESUME_CMD_RE = /^(?:恢复会话|resume)\s+(.+)$/i;
/** 关闭实例：`关闭实例 <pid>` */
export const KILL_INSTANCE_RE = /^(?:关闭实例|kill\s+inst?)\s+(\d+)$/i;
/** @标签 临时路由：`@faunet 消息`（路由层使用） */
export const TAG_ROUTE_RE = /^@([\w\u4e00-\u9fa5-]+)\s+([\s\S]+)$/;
/** 模型切换：`切换模型到 X` / `/model X` */
export const MODEL_SWITCH_RE = /^(?:切换模型(?:到)?|\/model)\s+(.+)$/i;
/** 实例数量上限（防失控） */
export const MAX_INSTANCES = 5;

export function summarizeArgs(args: any): string {
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
export function splitLongMarkdown(md: string, maxLen = 28000): string[] {
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
export function markdownToText(md: string): string {
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
export async function sessionDisplayName(s: any): Promise<string> {
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
      } catch (e) {
        void e; // 单行解析失败 → 跳过该行继续找
      }
    }
  } catch (e) {
    void e; // 文件读取失败 → 回落会话 ID 前缀
  }
  return s.id.slice(0, 8);
}

export function homeRelativeJoin(dir: string): string {
  return dir.replace(/^~/, homedir());
}
