/**
 * channel-gateway.ts — Facade 模式：Lark SDK 通道的构建/连接/心跳
 *
 * - buildChannel：通道工厂（策略：群聊 requireMention、单聊开放、WS 保活看门狗）
 * - connect：磁盘网关锁仲裁 + 指数退避重试（0/2/5s，重建 channel 保证内部状态干净）
 * - startHeartbeat：Observer 循环 —— 注册续约、锁接管、WS 恢复、队列消费
 */
import { rm } from "node:fs/promises";
import type { BotRuntime, FeishuBotConfig } from "./types.ts";
import { createLarkChannel, LarkChannelError, isSDKAvailable } from "./sdk.ts";
import {
  HEARTBEAT_MS,
  STALE_MS,
  INSTANCES_DIR,
  loadConfig,
} from "./storage.ts";
import { inboxDir } from "./mailbox.ts";
import {
  claimGatewayLock,
  readGatewayLock,
  releaseGatewayLock,
  renewGatewayLock,
} from "./gateway-lock.ts";
import { sleep } from "./utils.ts";

/** 通道工厂：每次 connect 尝试新建（失败后内部状态可能不干净） */
export function buildChannel(cfg: FeishuBotConfig) {
  // 注意：不传 domain！裸字符串 "feishu" 会导致 Invalid URL（SDK 期望完整 URL 或默认值）
  return createLarkChannel({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    transport: "websocket",
    // 从群成员 roster 解析发送者真实姓名（每个 chat 一次，带缓存；否则显示 ou_xxx）
    resolveSenderNames: true,
    policy: {
      requireMention: true, // 群聊必须 @Pi
      dmMode: "open", // 单聊全放行
    },
    safety: {
      chatQueue: { enabled: true, mergeWhileBusy: false },
      dedup: { ttl: 300_000 },
      staleMessageWindowMs: 10 * 60 * 1000,
    },
    loggerLevel: "warn",
    // WS 保活看门狗：连接僵死时自动强制重连
    keepalive: { enabled: true },
  });
}

export function attachChannelHandlers(rt: BotRuntime) {
  if (!rt.channel) return;
  rt.channel.on(
    "message",
    (msg: any) =>
      void rt.svc
        .handleFeishuMessage(msg)
        .catch((e: any) =>
          console.error("[feishubot] handle message error:", e),
        ),
  );
  rt.channel.on("error", (err: any) => {
    console.error(
      "[feishubot] channel error:",
      err?.code || "",
      err?.message || err,
    );
  });
  rt.channel.on("reconnecting", () => console.log("[feishubot] WS 重连中..."));
  rt.channel.on("reconnected", () => console.log("[feishubot] WS 已恢复"));
}

export function disconnect(rt: BotRuntime) {
  if (rt.channel) {
    try {
      rt.channel.disconnect();
    } catch (e) {
      void e; // 通道已断开
    }
    rt.channel = null;
  }
  rt.connected = false;
}

/** 连接：网关锁仲裁 + 重试退避。非网关实例自动转工作模式（返回 false） */
export async function connect(
  rt: BotRuntime,
  ctx: any,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  if (!isSDKAvailable()) return false;
  // force 模式（接管/恢复）也必须先拿到锁，杜绝双 WS
  if (opts.force && !(await claimGatewayLock(rt))) {
    rt.isGateway = false;
    console.log("[feishubot] 接管失败：网关锁被其它实例持有");
    return false;
  }
  rt.currentCtx = ctx;
  const cfg = await loadConfig();
  if (!cfg) {
    ctx.ui.notify("飞书机器人未配置：/feishubot-add 添加凭据", "warning");
    return false;
  }

  // 多实例单连接仲裁（磁盘锁仲裁）：抢到 gateway.lock 的实例持有飞书 WS，
  // 其余实例作为工作节点通过 inbox 接收路由消息（防止双连接消息随机分发导致串会话）
  if (!(await claimGatewayLock(rt))) {
    const lock = await readGatewayLock();
    rt.isGateway = false;
    console.log(
      `[feishubot] 网关锁由 PID ${lock?.pid} 持有，本实例以工作模式运行（收 inbox 路由）`,
    );
    return false;
  }
  rt.isGateway = true;

  disconnect(rt);

  const delays = [0, 2000, 5000];
  let lastErr: any = null;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      rt.channel = buildChannel(cfg);
      attachChannelHandlers(rt);
      await rt.channel.connect();
      lastErr = null;
      break;
    } catch (e: any) {
      lastErr = e;
      const cause = e?.context?.cause || e?.cause;
      console.error(
        `[feishubot] connect 尝试失败 (code=${e?.code}): ${e?.message}`,
        cause ? `| cause: ${cause?.message || cause}` : "",
      );
      try {
        rt.channel?.disconnect();
      } catch (e2) {
        void e2; // 通道清理失败可忽略
      }
      rt.channel = null;
    }
  }

  if (lastErr || !rt.channel) {
    rt.connected = false;
    const cause = lastErr?.context?.cause || lastErr?.cause;
    const causeMsg = cause ? ` | 底层原因: ${cause?.message || cause}` : "";
    const msg =
      lastErr instanceof LarkChannelError
        ? `${lastErr.code}: ${lastErr.message}`
        : lastErr?.message || String(lastErr);
    console.error("[feishubot] connect 最终失败:", msg, causeMsg);
    ctx.ui.notify(`飞书连接失败: ${msg}${causeMsg}`, "error");
    return false;
  }

  rt.connected = true;
  try {
    rt.botName = rt.channel.getBotIdentity()?.name || rt.botName;
  } catch (e) {
    void e; // 身份解析失败 → 保持默认名
  }
  ctx.ui.notify(`✅ 飞书机器人已连接: ${rt.botName}`, "info");
  console.log(`[feishubot] connected as ${rt.botName}`);
  return true;
}

/**
 * 启动心跳：注册续约 + 网关重选（原网关死亡时自动顶上接管 WS）
 * + 锁持有者消费发送队列（工作实例委托的回复）+ 死信转移
 */
export function startHeartbeat(rt: BotRuntime, ctx: any, pi: any) {
  if (rt.heartbeatTimer) clearInterval(rt.heartbeatTimer);
  rt.heartbeatTimer = setInterval(async () => {
    const { writeInstanceHeartbeat } = await import("./instances.ts");
    const { drainInbox, drainOutbox } = await import("./mailbox.ts");
    await writeInstanceHeartbeat(rt);
    try {
      const lock = await readGatewayLock();
      if (lock && lock.pid === rt.SELF_PID) {
        // 本实例持锁：续约 + 确保 WS 在线 + 消费发送队列
        await renewGatewayLock(rt);
        if (!rt.isGateway) rt.isGateway = true;
        if (!rt.channel) {
          console.log("[feishubot] 持锁实例恢复 WS 连接…");
          await connect(rt, ctx, { force: true });
        }
      } else if (rt.isGateway) {
        // 曾持锁但已失去（异常场景）：降级为工作模式（WS 由 SDK 保活，暂不断开避免闪断）
        rt.isGateway = false;
      } else if (
        !lock ||
        Date.now() - (lock?.heartbeat ?? 0) > STALE_MS - 1000
      ) {
        // 无锁或锁将死：抢占
        if (await claimGatewayLock(rt)) {
          console.log("[feishubot] 抢占到网关锁，接管 WS…");
          rt.isGateway = true;
          if (!rt.channel) await connect(rt, ctx, { force: true });
        }
      }
    } catch (e: any) {
      console.error("[feishubot] 心跳异常:", e?.message || e);
    }
    // 锁持有者消费发送队列（工作实例委托的回复）
    if (rt.isGateway && rt.channel) await drainOutbox(rt);
    // 网关顺便做死信转移
    await drainInbox(rt, pi);
  }, HEARTBEAT_MS);
}

/** 注销实例注册 + 清空自己的信箱 + 释放网关锁（session_shutdown 用） */
export async function teardown(rt: BotRuntime) {
  rm(`${INSTANCES_DIR}/${rt.SELF_PID}.json`, { force: true }).catch(() => {});
  await releaseGatewayLock(rt);
  rm(inboxDir(rt, rt.SELF_PID), { recursive: true, force: true }).catch(
    () => {},
  );
}
