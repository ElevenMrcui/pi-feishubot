/**
 * streaming.ts — State 模式：请求状态机 thinking → streaming → done
 *
 * 打字机卡片的关键设计：
 * - producer 保持 pending 直到流结束（提前 resolve 会触发 SDK rollover 产生新卡片）
 * - 占位回执：注入后 ACK_DELAY_MS 仍未出字 → 建占位卡，首个增量原地覆盖
 * - 静默 >30s → setContent 原地更新"仍在执行 Ns"（不堆积；超长缓冲只追加一行标记）
 * - 全局令牌桶：多聊天并发打字机共享飞书卡片更新 QPS 预算，防限频恶性循环
 * - 失败退避：append/setContent 连续失败按指数退避跳轮，finalize 全文兑底最终一致
 * - finalize：setContent 全文定格；失败回落普通回复
 */
import type { BotRuntime, FeishuRequest } from "./types.ts";
import { replyMarkdown, sendToChat } from "./sender.ts";

export const STREAM_FLUSH_MS = 700;

// ======== 全局卡片更新令牌桶（P0：多会话并发共享飞书 QPS 预算）========
// 飞书按 app 维度限频：N 个聊天同时流式时 700ms/请求的刷新会叠加触发限频，
// 限频失败又诱发全文重发 → 恶性循环。令牌桶让所有卡片更新排队共享 ~1.5 QPS。
const CARD_BUCKET_CAPACITY = 3;
const CARD_REFILL_MS = 650; // 稳态 ≈ 1.5 次/秒
let cardTokens = CARD_BUCKET_CAPACITY;
let cardLastRefillAt = Date.now();

function refillCardTokens() {
  const now = Date.now();
  const n = Math.floor((now - cardLastRefillAt) / CARD_REFILL_MS);
  if (n > 0) {
    cardTokens = Math.min(CARD_BUCKET_CAPACITY, cardTokens + n);
    cardLastRefillAt += n * CARD_REFILL_MS;
  }
}

/** 取一个卡片更新额度（额度不足时等待），用于流式 append / 心跳 setContent；
 *  finalize 定格不经过桶（关键路径优先） */
async function acquireCardSlot() {
  for (;;) {
    refillCardTokens();
    if (cardTokens > 0) {
      cardTokens--;
      return;
    }
    await sleep(150);
  }
}

// 静默心跳策略：全文重发从 15s 放宽到 30s；超长缓冲只追加一行耗时标记
// （全文 setContent 是 O(n²) 字节 + 高 QPS 消耗；标记行会被 finalize 全文覆盖）
const SILENT_HEARTBEAT_MS = 30_000;
const SILENT_FULLTEXT_MAX = 20_000;
const STREAM_BACKOFF_MAX_MS = 8_000;

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
        await acquireCardSlot();
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
    // flush 循环：把 buffer 增量推给卡片（令牌桶限速 + 失败指数退避 + 在途互斥）
    req.streamFlushTimer = setInterval(async () => {
      if (req.finalized || !req.streamCtrl) return;
      // 在途互斥：上轮还在等桶/网络时跳过本轮，防重入叠加
      if (req.streamFlushInFlight) return;
      req.streamFlushInFlight = true;
      try {
        // 失败退避中：本轮跳过，防限频恶性循环
        if ((req.streamNextAttemptAt || 0) > Date.now()) return;
        const buf = req.streamBuffer;
        // 运行心跳：静默超过 30s → 用 setContent 原地更新"已运行 Ns"（同一行，不堆积）；
        // 超长缓冲只追加一行耗时标记（全文重发是 O(n²) 字节）；
        // finalize 时 setContent 全文覆盖，心跳行不会留在最终结果里
        const activityBase = req.lastActivityAt || req.startedAtMs || Date.now();
        const silentMs = Date.now() - activityBase;
        const runSec = Math.round(
          (Date.now() - (req.startedAtMs || activityBase)) / 1000,
        );
        if (
          buf.length === req.streamAppended &&
          req.streamAppended > 0 &&
          silentMs > SILENT_HEARTBEAT_MS
        ) {
          try {
            await acquireCardSlot();
            if (buf.length <= SILENT_FULLTEXT_MAX) {
              await req.streamCtrl.setContent(
                `${buf}\n\n⏱ 仍在执行，累计 ${runSec}s…`,
              );
            } else {
              await req.streamCtrl.append(`\n\n⏱ 仍在执行，累计 ${runSec}s…`);
            }
            req.lastActivityAt = Date.now();
          } catch (e) {
            void e;
            // 心跳更新失败 → 同样计入失败退避，防限频时空转重试
            req.streamFailCount = (req.streamFailCount || 0) + 1;
            req.streamNextAttemptAt =
              Date.now() +
              Math.min(
                STREAM_FLUSH_MS * 2 ** (req.streamFailCount || 1),
                STREAM_BACKOFF_MAX_MS,
              );
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
          const appendedBefore = req.streamAppended;
          req.streamAppended = buf.length;
          try {
            await acquireCardSlot();
            await req.streamCtrl.append(chunk);
            req.streamFailCount = 0;
          } catch {
            // append 失败 → 全文 setContent 兑底（同样受限流桶约束）
            try {
              await acquireCardSlot();
              await req.streamCtrl.setContent(buf);
              req.streamFailCount = 0;
            } catch (e) {
              void e;
              // 双失败：回退水位到断点 + 指数退避，下轮从断点重试
              // （finalize 全文 setContent 兑底保证最终一致性）
              req.streamAppended = appendedBefore;
              req.streamFailCount = (req.streamFailCount || 0) + 1;
              req.streamNextAttemptAt =
                Date.now() +
                Math.min(
                  STREAM_FLUSH_MS * 2 ** (req.streamFailCount || 1),
                  STREAM_BACKOFF_MAX_MS,
                );
            }
          }
        }
      } finally {
        req.streamFlushInFlight = false;
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
  stopProgressNotifier(req);
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
    // 旧实现在这里盲等 sleep(300) 等节流器 flush——实测冗余：SDK 在 producer
    // resolve 后的 completeTerminal() 本身就会 await throttle.flushNow()
    // + await queue.drain()，并用 finishStreamingCard(全文) 带上最终内容。
    // 去掉后每条流式回复少 300ms 固定延迟（关键路径）。
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

// ========================================================================
// worker 进度播报（无流式卡片实例的状态可见性）
// ========================================================================

const PROGRESS_TICK_MS = 30_000; // 30s 节流
const PROGRESS_MAX_SENDS = 20; // 单请求上限，防刷屏

/**
 * worker 进度播报（安静版）：仅在「有真实工具活动且工具发生变化」时播报一条，
 * 纯思考 / 生成回答阶段不发消息（用户要求：过程中的“思考/生成回答中”属噪声，
 * 等最终回复即可）。网关实例有流式卡片（streamCtrl），整个机制自动跳过。
 */
export function startProgressNotifier(rt: BotRuntime, req: FeishuRequest) {
  if (req.progressTimer) return;
  if (rt.channel) return; // 网关：有打字机卡片，无需文本播报
  req.progressSent = 0;
  req.progressLastSig = "";
  req.progressTimer = setInterval(async () => {
    if (req.finalized) {
      stopProgressNotifier(req);
      return;
    }
    if (req.progressSent >= PROGRESS_MAX_SENDS) {
      stopProgressNotifier(req);
      return;
    }
    const info = rt.activeToolInfo;
    // 无工具活动 = 思考/生成中 → 静默（不发任何消息）
    if (!info) return;
    const sec = Math.round((Date.now() - (req.startedAtMs || Date.now())) / 1000);
    const sig = `${info.name}|${info.argsSummary}`;
    // 同一工具持续执行 → 不重复刷屏
    if (sig === req.progressLastSig) return;
    req.progressLastSig = sig;
    const tool = `正在执行 \`${info.name}\`${info.argsSummary ? ` (${info.argsSummary})` : ""}`;
    try {
      await sendToChat(rt, req.chatId, `⏳ [${sec}s] ${tool}`);
      req.progressSent++;
    } catch (e) {
      void e; // 单次播报失败 → 下轮重试
    }
  }, PROGRESS_TICK_MS);
}

export function stopProgressNotifier(req: FeishuRequest) {
  if (req.progressTimer) {
    clearInterval(req.progressTimer);
    req.progressTimer = null;
  }
}
