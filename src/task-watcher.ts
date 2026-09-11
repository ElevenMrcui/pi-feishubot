/**
 * task-watcher.ts — faunet 任务完成监听器（网关轮询 daemon → 绑定聊天通知）
 *
 * 背景：faunet daemon 为拉模式（无推送），UI 发布的任务完成后无任何通知通道。
 * 设计：仅网关实例（isGateway && connected）轮询；快照对比检测终态迁移；
 *       通知广播到所有绑定聊天（bindings 反查）。
 */
import type { BotRuntime } from "./types.ts";

const POLL_MS = 30_000;
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

async function daemonBase(): Promise<string | null> {
  for (let port = 7900; port <= 7919; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(800),
      });
      if (r.ok) return `http://127.0.0.1:${port}`;
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

/** 启动任务监听（仅网关实例调用；非网关 no-op） */
export function startTaskWatcher(rt: BotRuntime) {
  if (!rt.isGateway || rt.taskWatcherTimer) return;
  rt.taskWatcherTimer = setInterval(async () => {
    try {
      const base = await daemonBase();
      if (!base) return;
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
  }, 30_000);
}

export function stopTaskWatcher(rt: BotRuntime) {
  if (rt.taskWatcherTimer) {
    clearInterval(rt.taskWatcherTimer);
    rt.taskWatcherTimer = null;
  }
  primed = false;
}
