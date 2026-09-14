/**
 * task-watcher.ts — faunet 任务完成监听器（网关轮询 daemon → 绑定聊天通知）
 *
 * 背景：faunet daemon 为拉模式（无推送），UI 发布的任务完成后无任何通知通道。
 * 设计：仅网关实例（isGateway && connected）轮询；快照对比检测终态迁移；
 *       通知广播到所有绑定聊天（bindings 反查）。
 */
import type { BotRuntime } from "./types.ts";

const POLL_MS = 30_000;
const MAX_POLL_MS = 300_000; // daemon 不在时退避封顶 5min（避免每 30s 空扫 16 个端口）
const NOTIFY_STATUSES = new Set(["completed", "failed", "degraded"]);
const STATUS_LABEL: Record<string, string> = {
  completed: "✅ 已完成",
  failed: "❌ 失败",
  degraded: "🟡 降级完成",
};

interface TaskRow {
  task_id: string;
  mode: string;
  status: string;
  title?: string;
  cost_usd?: number;
  subtasks_total?: number;
  subtasks_done?: number;
  subtasks_failed?: number;
}

const snapshot = new Map<string, string>();
let primed = false;
/** 上次成功的 daemon 地址：优先探活，避免每轮全端口扫描 */
let cachedBase: string | null = null;
/** 当前轮询间隔（daemon 不在时指数退避，恢复后回 POLL_MS） */
let pollDelay = POLL_MS;

async function daemonBase(): Promise<string | null> {
  // 记住上次成功端口优先探活（O(1)）；失效再全扫
  if (cachedBase) {
    try {
      const r = await fetch(`${cachedBase}/healthz`, {
        signal: AbortSignal.timeout(800),
      });
      if (r.ok) return cachedBase;
    } catch {
      void 0; // 缓存端口已失效 → 重新扫描
    }
    cachedBase = null;
  }
  for (let port = 7900; port <= 7919; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(800),
      });
      if (r.ok) {
        cachedBase = `http://127.0.0.1:${port}`;
        return cachedBase;
      }
    } catch {
      void 0; // 端口未开 → 下一个
    }
  }
  return null;
}

/**
 * 通知目标：绑定到「非本实例会话」的聊天（即远端会话的聊天）。
 * 网关自身会话的绑定排除（那是 faunet 实例自己的聊天，任务通知无意义）。
 * 实现读取 pi-bridge 注入的 rt.__boundChats（综合实例绑定的聊天集）。
 */
function notifyChats(rt: BotRuntime): string[] {
  const bound: string[] = (rt as any).__boundChats || [];
  return bound.length ? bound : [];
}

/** 单条任务通知（发到所有绑定聊天） */
async function notifyTask(rt: BotRuntime, t: TaskRow) {
  const targets = new Set(notifyChats(rt));
  const label = STATUS_LABEL[t.status] || t.status;
  const sub =
    t.subtasks_total == null
      ? ""
      : ` · 子任务 ${t.subtasks_done}/${t.subtasks_total}` +
        (t.subtasks_failed ? `（失败 ${t.subtasks_failed}）` : "");
  const cost = t.cost_usd == null ? "" : ` · 成本 $${t.cost_usd.toFixed(3)}`;
  const title = (t.title || t.task_id).slice(0, 40);
  const md = `🐺 任务${label}：**${title}**${sub}${cost}`;
  for (const chat of targets) {
    try {
      await rt.channel?.send(chat, { markdown: md });
    } catch (e) {
      void e; // 单聊天发送失败不影响其他
    }
  }
}

/** 启动任务监听（仅网关实例调用；非网关 no-op）。setTimeout 链驱动，支持动态退避 */
export function startTaskWatcher(rt: BotRuntime) {
  if (!rt.isGateway || rt.taskWatcherTimer) return;
  const tick = async () => {
    try {
      const base = await daemonBase();
      if (!base) {
        // daemon 不在：指数退避（30s→60s→…→5min），空转成本降至可忽略
        pollDelay = Math.min(pollDelay * 2, MAX_POLL_MS);
        return;
      }
      pollDelay = POLL_MS;
      const r = await fetch(`${base}/api/tasks`);
      if (!r.ok) return;
      const d = (await r.json()) as { tasks?: TaskRow[] };
      const tasks = d.tasks || [];

      if (!primed) {
        // 首拍只记录不通知（避免历史任务轰炸）
        for (const t of tasks) snapshot.set(t.task_id, t.status);
        primed = true;
        return;
      }

      const fresh: TaskRow[] = [];
      for (const t of tasks) {
        const prev = snapshot.get(t.task_id);
        snapshot.set(t.task_id, t.status);
        if (NOTIFY_STATUSES.has(t.status) && prev !== t.status) {
          fresh.push(t);
        }
      }
      // 单轮最多 5 条防刷屏
      for (const t of fresh.slice(0, 5)) {
        await notifyTask(rt, t);
      }
    } catch (e) {
      void e; // 轮询失败 → 下轮重试
    }
    // 本轮结束后按当前节奏排下一轮（stop 置空 timer 则不再排）
    if (rt.taskWatcherTimer !== null) {
      rt.taskWatcherTimer = setTimeout(tick, pollDelay);
    }
  };
  rt.taskWatcherTimer = setTimeout(tick, pollDelay);
}

export function stopTaskWatcher(rt: BotRuntime) {
  if (rt.taskWatcherTimer) {
    clearTimeout(rt.taskWatcherTimer);
    rt.taskWatcherTimer = null;
  }
  primed = false;
  pollDelay = POLL_MS;
}
