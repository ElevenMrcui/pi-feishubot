/**
 * runtime.ts — Singleton 模式：进程内唯一的共享可变状态容器
 *
 * 原实现是 2271 行闭包里的隐式共享变量；组件化后显式化为一个 runtime 对象，
 * 由组合根（main.ts）创建一次并注入所有组件（Dependency Injection）。
 */
import type { BotRuntime } from "./types.ts";

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

    // 去重
    seenMessages: new Set(),
    finalizedMessageIds: new Set(),

    // 绑定表缓存
    chatBindings: {},

    // 实例角色
    SELF_PID: process.pid,
    isGateway: false,
    heartbeatTimer: null,
    inboxWatcher: null,
    outboxWatcher: null,
    startedAt: Date.now(),

    // 互斥标志
    draining: false,
    outboxDraining: false,

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
