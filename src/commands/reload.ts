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
      // 任务执行中禁止重载：reload 会 invalidate 当前扩展上下文，正在跑的
      // 请求其回复会永久丢失（与 `切会话` 同规则）
      const busy = rt.currentCtx ? !rt.currentCtx.isIdle() : false;
      if (busy) {
        await replyMarkdown(
          rt,
          req,
          "⏳ 当前有任务执行中，重载会丢失本次回复。请等任务结束后再发 `重载`（或先 `停止`）。",
        );
        return true;
      }
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
            // 不得向会话注入 /feishubot-reload：该 prompt 模板本仓并不存在，注入等于
            // 把命令文本当提示词喂给 LLM（它会开始“回答”这条指令）。
            // ctx.reload 是 pi 稳定 API，缺失只可能是上下文已失效 → 只提示手操。
            console.error(
              "[feishubot] ctx.reload 不可用（上下文已失效？），跳过重载",
            );
            await replyMarkdown(
              rt,
              req,
              "⚠️ 重载上下文不可用（实例可能刚切换过会话），请在终端里执行 `/reload`",
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
