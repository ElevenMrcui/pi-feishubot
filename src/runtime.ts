/**
 * runtime.ts — Singleton 模式：进程内唯一的共享可变状态容器
 *
 * 原实现是 2271 行闭包里的隐式共享变量；组件化后显式化为一个 runtime 对象，
 * 由组合根（main.ts）创建一次并注入所有组件（Dependency Injection）。
 */
import type { BotRuntime } from "./types.ts";
import { createRequire } from "node:module";

/** 扩展版本（加载时从 package.json 读取）：供 `状态` 指令展示，
 *  以便区分“磁盘最新代码”与“进程内实际运行版本”（重载后才一致） */
const nodeRequire = createRequire(import.meta.url);
export const BOT_VERSION: string = (() => {
  try {
    return (nodeRequire("../package.json") as any)?.version || "?";
  } catch (e) {
    void e;
    return "?";
  }
})();

/** 未装配占位：never 返回值兼容任何函数签名，装配前误调用立即显式报错 */
function notWired(): never {
  throw new Error("[feishubot] Mediator 服务表尚未装配（组合根 bug）");
}

export function createRuntime(): BotRuntime {
  return {
    // 连接状态
    channel: null,
    sendOnlyChannel: null,
    connected: false,
    currentCtx: null,
    botName: "Pi",

    // 请求状态机
    requests: new Map(),
    activeRequest: null,
    lastSessionList: [],

    // 全局进度跟踪
    activeToolInfo: null,

    // 去重（值 = 写入时间戳，心跳周期清扫）
    seenMessages: new Map(),
    finalizedMessageIds: new Map(),

    // 绑定表缓存
    chatBindings: {},
    senderBindings: {},

    // 实例角色
    SELF_PID: process.pid,
    isGateway: false,
    heartbeatTimer: null,
    taskWatcherTimer: null,
    inboxWatcher: null,
    outboxWatcher: null,
    mailboxPollTimer: null,
    configWatcher: null,
    configPollTimer: null,
    startedAt: Date.now(),
    stats: { received: 0, replied: 0 },

    // 互斥标志
    draining: false,
    outboxDraining: false,
    pendingReplies: new Map(),

    // Mediator 服务表（组合根装配，装配前误调用立即显式报错）
    svc: {
      handleFastCommand: notWired,
      matchesFastCommand: notWired,
      findFastCommand: notWired,
      handleFeishuMessage: notWired,
      scheduleAck: notWired,
      sendToChat: notWired,
      connect: notWired,
      drainOutbox: notWired,
      drainInbox: notWired,
    },
  };
}
