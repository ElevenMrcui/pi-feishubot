/**
 * streaming.ts — State 模式：请求状态机 thinking → streaming → done
 *
 * 打字机卡片的关键设计：
 * - producer 保持 pending 直到流结束（提前 resolve 会触发 SDK rollover 产生新卡片）
 * - 占位回执：注入后 ACK_DELAY_MS 仍未出字 → 建占位卡，首个增量原地覆盖
 * - 静默 >15s → setContent 原地更新"仍在执行 Ns"（不堆积消息）
 * - finalize：setContent 全文定格；失败回落普通回复
 */
import type { BotRuntime, FeishuRequest } from "./types.ts";
import { replyMarkdown } from "./sender.ts";

export const STREAM_FLUSH_MS = 700;

/**
 * 占位回执：注入后 ACK_DELAY_MS 仍未出字 → 提前建卡显示"正在处理"，
 * 首个真实增量会原地覆盖占位（全程一张卡片，无撤回）。
 */
const ACK_DELAY_MS = 1000;
const ACK_PLACEHOLDER = "🫥 正在处理…";

export function clearAckTimer(req: FeishuRequest) {
  if (req.ackTimer) {
    clearTimeout(req.ackTimer);
    req.ackTimer = null;
  }
}

export function scheduleAck(rt: BotRuntime, req: FeishuRequest) {
  clearAckTimer(req);
  req.ackTimer = setTimeout(() => {
    req.ackTimer = null;
    // 已在流式/已完结/卡片已建 → 不需要占位
    if (req.finalized || req.phase !== "thinking" || req.streamCtrl) return;
    ensureStream(rt, req, ACK_PLACEHOLDER);
    // 占位期心跳：每 10s 更新"仍在运行"，让用户确认没有失踪
    const started = req.startedAtMs || Date.now();
    req.aliveTimer = setInterval(async () => {
      if (req.finalized || req.phase !== "thinking" || !req.streamCtrl) {
        if (req.aliveTimer) {
          clearInterval(req.aliveTimer);
          req.aliveTimer = null;
        }
        return;
      }
      const sec = Math.round((Date.now() - started) / 1000);
      try {
        await req.streamCtrl.setContent(`🫥 仍在运行… 累计 ${sec}s`);
      } catch (e) {
        void e; // 占位心跳更新失败 → 下一轮重试
      }
    }, 10_000);
  }, ACK_DELAY_MS);
}

/** 建立流式卡片 + flush 定时器（首个 text_delta 或占位回执时触发） */
export function ensureStream(
  rt: BotRuntime,
  req: FeishuRequest,
  placeholder?: string,
) {
  if (req.phase !== "thinking" || !rt.channel) return;
  req.phase = "streaming";
  if (!req.lastActivityAt) req.lastActivityAt = Date.now();
  if (placeholder) req.streamPlaceholder = placeholder;

  // 关键：producer 必须保持 pending 直到流真正结束。
  // SDK 的 run(producer) 在 producer resolve 时立即 completeTerminal() 完结卡片；
  // 若提前 resolve，后续 append 会触发 rollover 产生新卡片消息（多条中间消息的根源）。
  const producer = (ctrl: any) => {
    req.streamCtrl = ctrl;
    // 占位模式：拿到 ctrl 后立即写入"正在处理"占位文本（修复占位卡空白问题）
    if (req.streamPlaceholder) {
      void ctrl.setContent(req.streamPlaceholder).catch(() => {});
    }
    // flush 循环：把 buffer 增量推给卡片
    req.streamFlushTimer = setInterval(async () => {
      if (req.finalized || !req.streamCtrl) return;
      const buf = req.streamBuffer;
      // 运行心跳：静默超过 15s → 用 setContent 原地更新"已运行 Ns"（同一行，不堆积）；
      // finalize 时 setContent 全文覆盖，心跳行不会留在最终结果里
      const activityBase = req.lastActivityAt || req.startedAtMs || Date.now();
      const silentMs = Date.now() - activityBase;
      const runSec = Math.round(
        (Date.now() - (req.startedAtMs || activityBase)) / 1000,
      );
      if (
        buf.length === req.streamAppended &&
        req.streamAppended > 0 &&
        silentMs > 15_000
      ) {
        try {
          await req.streamCtrl.setContent(
            `${buf}\n\n⏱ 仍在执行，累计 ${runSec}s…`,
          );
          req.lastActivityAt = Date.now();
        } catch (e) {
          void e; // 心跳更新失败 → 下轮 flush 重试
        }
        return;
      }
      if (buf.length > req.streamAppended) {
        // 占位卡首刷：setContent 全量覆盖"正在处理"占位文本
        if (req.streamPlaceholder) {
          req.streamPlaceholder = null;
          req.streamAppended = buf.length;
          try {
            await req.streamCtrl.setContent(buf);
          } catch (e) {
            void e; // 首刷失败 → 退回增量 append 路径
          }
          return;
        }
        const chunk = buf.slice(req.streamAppended);
        req.streamAppended = buf.length;
        try {
          await req.streamCtrl.append(chunk);
        } catch {
          try {
            await req.streamCtrl.setContent(buf);
          } catch (e) {
            void e; // flush 失败 → 下轮重试
          }
        }
      }
    }, STREAM_FLUSH_MS);
    return new Promise<void>((resolve) => {
      // Promise 执行器同步运行：这里赋值才能保证 finalize 拿到 resolve 函数
      (req as any).resolveProducer = resolve;
    });
  };

  void rt.channel
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
export async function finalizeRequest(
  rt: BotRuntime,
  req: FeishuRequest,
  finalMd: string,
) {
  if (req.finalized) return;
  req.finalized = true;
  req.phase = "done";
  clearAckTimer(req);
  if (req.aliveTimer) {
    clearInterval(req.aliveTimer);
    req.aliveTimer = null;
  }

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
    // 注意 SDK 的 throttle 是异步的，setContent 仅标记最大优先级，由节流器统一 flush。
    await sleep(300);
    const resolveProducer = (req as any).resolveProducer as
      | (() => void)
      | undefined;
    if (resolveProducer) {
      try {
        resolveProducer();
      } catch (e) {
        void e; // producer 已结束
      }
      (req as any).resolveProducer = null;
    }
    if (!settled) {
      await replyMarkdown(rt, req, finalMd);
    }
  } else {
    await replyMarkdown(rt, req, finalMd);
  }

  rt.requests.delete(req.messageId);
  if (rt.activeRequest === req) rt.activeRequest = null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
