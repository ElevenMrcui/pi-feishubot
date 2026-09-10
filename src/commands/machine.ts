/**
 * commands/machine.ts — Command 模式：本机遥控指令
 * （喊话 TTS 外放 / 停止喊话 / 音量调节 / 静音）
 *
 * 全部实例同机运行，路由到任一实例效果一致。
 */
import { execFile, spawn } from "node:child_process";
import type { BotRuntime, FastCommand } from "../types.ts";
import { replyMarkdown } from "../sender.ts";

const VOICE = "Tingting";
const RATE = "185";

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------- 喊话

export function createSayCommand(rt: BotRuntime): FastCommand {
  return {
    name: "say",
    match: (text) => /^(?:喊话|外放|语音)\s+[\s\S]+$/.test(text.trim()),
    async execute(req, text) {
      const content = text.trim().replace(/^(?:喊话|外放|语音)\s+/, "").slice(0, 200);
      if (!content) {
        await replyMarkdown(rt, req, "○ 喊话内容不能为空。用法：`喊话 <文本>`");
        return true;
      }
      // 后台播放，立即回执（say 播放是同步阻塞的）
      const child = spawn("say", ["-v", VOICE, "-r", RATE, content], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      await replyMarkdown(rt, req, `📢 外放中（婷婷）：${content}`);
      return true;
    },
  };
}

// ---------------------------------------------------------------- 停止喊话

export function createStopSayCommand(rt: BotRuntime): FastCommand {
  return {
    name: "stop-say",
    match: (_text, lower) =>
      lower === "停止喊话" || lower === "别喊了" || lower === "停止外放",
    async execute(req) {
      try {
        await run("pkill", ["say"]);
        await replyMarkdown(rt, req, "🤫 已停止外放。");
      } catch (e: any) {
        await replyMarkdown(rt, req, `○ 停止失败: ${e?.message || e}`);
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------- 音量

export function createVolumeCommand(rt: BotRuntime): FastCommand {
  return {
    name: "volume",
    match: (text) => /^(?:音量|volume)\s*\d{1,3}$/i.test(text.trim()),
    async execute(req, text) {
      const n = parseInt(text.trim().replace(/^(?:音量|volume)\s*/i, ""), 10);
      if (Number.isNaN(n) || n < 0 || n > 100) {
        await replyMarkdown(rt, req, "用法：`音量 <0-100>`，如 `音量 60`");
        return true;
      }
      try {
        await run("osascript", ["-e", `set volume output volume ${n}`]);
        await replyMarkdown(rt, req, `🔊 系统音量已设为 ${n}%`);
      } catch (e: any) {
        await replyMarkdown(rt, req, `❌ 音量调节失败: ${e?.message || e}`);
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------- 静音

export function createMuteCommand(rt: BotRuntime): FastCommand {
  return {
    name: "mute",
    match: (_text, lower) => lower === "静音" || lower === "mute",
    async execute(req) {
      try {
        await run("osascript", ["-e", "set volume output muted true"]);
        await replyMarkdown(rt, req, "🔇 已静音（`音量 60` 可恢复）");
      } catch (e: any) {
        await replyMarkdown(rt, req, `❌ 静音失败: ${e?.message || e}`);
      }
      return true;
    },
  };
}
