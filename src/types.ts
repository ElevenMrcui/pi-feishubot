/**
 * types.ts — 组件间类型契约
 *
 * 设计说明：
 * - BotRuntime：Singleton 共享可变状态容器（原 2271 行闭包变量的显式化）
 * - FastCommand：Command 模式的指令抽象
 * - RouteHandler：Chain of Responsibility 的路由处理器抽象
 *
 * 注意：本目录刻意不 import pi 包类型（@mariozechner/pi-coding-agent）——
 * 运行时由 pi 的 jiti virtualModules 注入，静态解析不可用；
 * 与宿主交互的类型一律用 any 宽松契约（与原实现一致）。
 */

// ============================================================================
// 配置
// ============================================================================

export interface FeishuBotConfig {
 appId: string;
 appSecret: string;
 name?: string;
}

// ============================================================================
// 实例注册表
// ============================================================================

export interface InstanceInfo {
 pid: number;
 sessionFile: string;
 sessionName: string;
 cwd: string;
 startedAt: number;
 heartbeat: number;
}

// ============================================================================
// 单条飞书消息的处理上下文（状态机）
// ============================================================================

export type RequestPhase = "thinking" | "streaming" | "done";

export interface FeishuRequest {
 chatId: string;
 messageId: string;
 senderName: string;
 /** 发送方 open_id（发送方级路由绑定键的一半） */
 senderId?: string;
 threadId?: string;
 phase: RequestPhase;
 streamCtrl: any | null; // MarkdownStreamController
 streamBuffer: string;
 streamFlushTimer: NodeJS.Timeout | null;
 streamAppended: number; // 已 append 的字符数
 streamPlaceholder?: string | null; // "处理中"占位文本（占位卡首刷时覆盖）
 ackTimer: NodeJS.Timeout | null; // 占位回执定时器
 aliveTimer: NodeJS.Timeout | null; // 运行心跳定时器（占位期更新"仍在运行 n s"）
 progressTimer: NodeJS.Timeout | null; // worker 进度播报定时器（无流式卡片的实例）
 progressSent: number; // 已发进度条数（防刷屏上限）
 lastActivityAt: number; // 最近一次内容活动（delta/append）时间
 startedAtMs?: number;
 finalized: boolean;
 viaInbox?: boolean; // 来自其它实例投递（回复走兜底直发，无流式卡片）
}

// ============================================================================
// Command 模式 —— 快捷指令抽象
// ============================================================================

export interface FastCommand {
 /** 指令名（调试/帮助用） */
 name: string;
 /**
  * 是否匹配该指令。lower 为小写化全文，raw 为原文。
  */
 match(text: string, lower: string): boolean;
 /**
  * 执行指令。返回 true 表示已消费（不再注入 LLM）。
  * 抛异常由调用方统一兜底回执。
  */
 execute(req: FeishuRequest, text: string, lower: string): Promise<boolean>;
 /**
  * 网关级指令：绑定到其它实例的消息也留在网关本地执行
  * （如 实例/会话 列表 —— 查询的是全局注册表，不依赖单个会话）。
  */
 localOnly?: boolean;
}

// ============================================================================
// 路由链
// ============================================================================

export interface RouteContext {
 msg: any; // 归一化 NormalizedMessage
 req: FeishuRequest;
 text: string;
 lower: string;
 /** @标签命中本实例时置位：后续环（绑定路由）必须跳过，消息在本实例落地 */
 routeToLocal?: boolean;
}

/** 返回 true = 已消费（链终止）；false = 交给下一个处理器 */
export type RouteHandler = (rc: RouteContext) => Promise<boolean>;

// ============================================================================
// BotRuntime —— Singleton 共享可变状态 + Mediator 服务表
// ============================================================================

/** 晚绑定服务表（Mediator）：打破模块间循环依赖，由组合根装配 */
export interface BotServices {
 handleFastCommand(req: FeishuRequest, text: string): Promise<boolean>;
 matchesFastCommand(text: string): boolean;
 findFastCommand(text: string): FastCommand | null;
 handleFeishuMessage(msg: any): Promise<void>;
 scheduleAck(req: FeishuRequest): void;
 sendToChat(chatId: string, md: string, threadId?: string): Promise<void>;
 connect(ctx: any, opts?: { force?: boolean }): Promise<boolean>;
 drainOutbox(): Promise<void>;
 drainInbox(): Promise<void>;
}

export interface BotRuntime {
 // ---- 连接状态 ----
 channel: any | null;
 /** 仅发送通道（无 WS）：工作实例的回复直发，不依赖网关代发 */
 sendOnlyChannel: any | null;
 connected: boolean;
 currentCtx: any | null; // ExtensionContext（宽松契约，见文件头说明）
 botName: string;

 // ---- 请求状态机 ----
 requests: Map<string, FeishuRequest>;
 activeRequest: FeishuRequest | null;
 lastSessionList: any[];

 // ---- 全局进度跟踪 ----
 activeToolInfo: {
  name: string;
  argsSummary: string;
  startedAt: number;
 } | null;

 // ---- 去重 / 防重 ----
 seenMessages: Set<string>;
 finalizedMessageIds: Set<string>;

 // ---- 会话路由绑定表缓存 ----
 chatBindings: Record<string, string>;
 /** 发送方级绑定："chatId|senderId" → 会话文件（同群不同人各绑各的） */
 senderBindings: Record<string, string>;

 // ---- 实例角色 ----
 readonly SELF_PID: number;
 isGateway: boolean;
 heartbeatTimer: NodeJS.Timeout | null;
 taskWatcherTimer: NodeJS.Timeout | null;
 inboxWatcher: FSWatcher | null;
 outboxWatcher: FSWatcher | null;
 mailboxPollTimer: NodeJS.Timeout | null;
 configWatcher: FSWatcher | null;
 configPollTimer: NodeJS.Timeout | null;
 readonly startedAt: number;
 /** 可观测性计数：已接收（注入 pi）与已回传（飞书）的消息数 */
 stats: { received: number; replied: number };

 // ---- 内部互斥标志 ----
 draining: boolean;
 outboxDraining: boolean;

 // ---- Mediator 服务表（组合根装配） ----
 svc: BotServices;
}

import type { FSWatcher } from "node:fs";
