/**
 * instances.ts — Registry 模式：实例注册表
 *
 * 多实例自动入网：每个 pi 进程启动时注册 {pid}.json 并心跳续约；
 * 死实例（心跳超时）被顺带清理。网关 = 存活实例中 startedAt 最早者
 * （确定性选举，所有实例算出同一结果）。
 */
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { INSTANCES_DIR, STALE_MS } from "./storage.ts";
import type { BotRuntime, InstanceInfo } from "./types.ts";
import { sleep } from "./utils.ts";

/** 当前实例所处的会话文件路径 */
export function currentSessionFile(rt: BotRuntime): string {
  const sm = rt.currentCtx?.sessionManager;
  if (!sm) return "";
  return (
    sm.sessionFile ||
    sm.sessionPath ||
    (typeof sm.getSessionFile === "function" ? sm.getSessionFile() : "") ||
    ""
  );
}

export async function writeInstanceHeartbeat(rt: BotRuntime) {
  if (!existsSync(INSTANCES_DIR)) {
    await mkdir(INSTANCES_DIR, { recursive: true }).catch(() => {});
  }
  const info: InstanceInfo = {
    pid: rt.SELF_PID,
    sessionFile: currentSessionFile(rt),
    sessionName: rt.currentCtx?.sessionManager?.getSessionName?.() || "",
    cwd: rt.currentCtx?.cwd || process.cwd(),
    startedAt: rt.startedAt,
    heartbeat: Date.now(),
  };
  await writeFile(
    join(INSTANCES_DIR, `${rt.SELF_PID}.json`),
    JSON.stringify(info, null, 2),
  ).catch(() => {});
}

/** 列出存活实例（心跳新鲜）；顺带清理僵尸注册文件 */
export async function listLiveInstances(
  rt: BotRuntime,
): Promise<InstanceInfo[]> {
  const out: InstanceInfo[] = [];
  try {
    for (const f of await readdir(INSTANCES_DIR)) {
      if (!f.endsWith(".json")) continue;
      const fp = join(INSTANCES_DIR, f);
      try {
        const info = JSON.parse(await readFile(fp, "utf8")) as InstanceInfo;
        if (Date.now() - info.heartbeat > STALE_MS) {
          await rm(fp).catch(() => {});
          continue;
        }
        out.push(info);
      } catch (e) {
        void e; // 损坏的注册文件 → 删除
        await rm(fp).catch(() => {});
      }
    }
  } catch (e) {
    void e; // 注册目录不存在 → 空列表
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}

/** 网关选举：存活实例中 startedAt 最早者 */
export function electGateway(instances: InstanceInfo[]): InstanceInfo | null {
  return instances[0] || null;
}

/** 按会话文件找承载它的存活实例（优先非自己） */
export async function findInstanceBySession(
  rt: BotRuntime,
  sessionFile: string,
): Promise<InstanceInfo | null> {
  const live = await listLiveInstances(rt);
  return (
    live.find((x) => x.pid !== rt.SELF_PID && x.sessionFile === sessionFile) ||
    live.find((x) => x.sessionFile === sessionFile) ||
    null
  );
}

/** 按 @标签 找实例：目录名 / 会话名 / 注册表关键词，取最近活跃 */
export async function findInstanceByTag(
  rt: BotRuntime,
  tag: string,
): Promise<InstanceInfo | null> {
  const live = await listLiveInstances(rt);
  if (!live.length) return null;
  const q = tag.toLowerCase();
  return (
    live.find((x) => (x.cwd || "").toLowerCase().endsWith("/" + q)) ||
    live.find((x) => (x.cwd || "").toLowerCase().split("/").pop() === q) ||
    live.find((x) => (x.sessionName || "").toLowerCase().includes(q)) ||
    live.find((x) => x.sessionFile.toLowerCase().includes(q)) ||
    null
  );
}

/** 轮询等待新实例上线（注册表出现新 pid） */
export async function waitNewInstance(
  rt: BotRuntime,
  knownPids: Set<number>,
  timeoutMs = 20_000,
): Promise<InstanceInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    const live = await listLiveInstances(rt);
    const fresh = live.find((x) => !knownPids.has(x.pid));
    if (fresh) return fresh;
  }
  return null;
}
