/**
 * commands/reload.ts — Command 模式：重载指令
 *
 * 重载收到消息的这个 pi 实例（先回执后异步触发，reload 会 invalidate 当前扩展上下文）。
 * 含常见错拼容错（rwload/relaod/rewload/relode）。
 */
import type { BotRuntime, FastCommand } from "../types.ts";
import { replyMarkdown } from "../sender.ts";
import { RELOAD_RE } from "../utils.ts";

export function createReloadCommand(rt: BotRuntime, pi: any): FastCommand {
  return {
    name: "reload",
    match: (_text, lower) =>
      lower === "重载" || lower === "/reload" || RELOAD_RE.test(lower),
    async execute(req) {
      await replyMarkdown(
        rt,
        req,
        "🔄 收到，正在重载当前 pi 实例的扩展与配置…",
      );
      // 让回执先送达，再异步触发（reload 会 invalidate 当前扩展上下文）
      setTimeout(async () => {
        try {
          const ctxAny = rt.currentCtx as any;
          if (ctxAny && typeof ctxAny.reload === "function") {
            await ctxAny.reload();
          } else {
            await pi.sendUserMessage(
              [{ type: "text", text: "/feishubot-reload" }],
              { expandPromptTemplates: true } as any,
            );
          }
        } catch (e: any) {
          console.error("[feishubot] reload 失败:", e?.message || e);
        }
      }, 400);
      return true;
    },
  };
}
