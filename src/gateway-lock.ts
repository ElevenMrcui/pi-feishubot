/**
 * gateway-lock.ts — 磁盘仲裁锁（Single-Writer 模式）
 *
 * 网关锁是「谁持有飞书 WS 与发送队列消费权」的唯一真相源：
 * - 抢到锁的实例建立 WS；其余实例作为工作节点收 inbox 路由
 * - 心跳续约；锁死亡（超时）时其他实例可抢占接管
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CONFIG_DIR, GATEWAY_LOCK, STALE_MS } from "./storage.ts";
import type { BotRuntime } from "./types.ts";

export async function readGatewayLock(): Promise<{
  pid: number;
  heartbeat: number;
} | null> {
  try {
    const j = JSON.parse(await readFile(GATEWAY_LOCK, "utf8"));
    if (Date.now() - j.heartbeat > STALE_MS) return null; // 锁已死
    return j;
  } catch (e) {
    void e; // 无锁文件 → 视为空闲
    return null;
  }
}

export async function claimGatewayLock(rt: BotRuntime): Promise<boolean> {
  const existing = await readGatewayLock();
  if (existing && existing.pid !== rt.SELF_PID) return false; // 他人持有且新鲜
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true }).catch(() => {});
  }
  await writeFile(
    GATEWAY_LOCK,
    JSON.stringify({ pid: rt.SELF_PID, heartbeat: Date.now() }),
  );
  return true;
}

export async function renewGatewayLock(rt: BotRuntime) {
  try {
    await writeFile(
      GATEWAY_LOCK,
      JSON.stringify({ pid: rt.SELF_PID, heartbeat: Date.now() }),
    );
  } catch (e) {
    void e; // 续约失败 → 下一轮心跳重试
  }
}

export async function releaseGatewayLock(rt: BotRuntime) {
  try {
    const j = JSON.parse(await readFile(GATEWAY_LOCK, "utf8"));
    if (j.pid === rt.SELF_PID) await rm(GATEWAY_LOCK).catch(() => {});
  } catch (e) {
    void e; // 锁已不存在 → 无需释放
  }
}
