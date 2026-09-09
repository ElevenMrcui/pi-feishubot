/**
 * storage.ts — Repository 模式：所有磁盘持久化的唯一出入口
 *
 * 职责：config.json（凭据）/ bindings.json（会话路由表）/ auth.json（登录 providers）
 *      / bai-models-cache.json（登录模型目录）/ settings.json（defaultModel 回写）
 * 其余组件不直接碰这些文件。
 */
import { readFile, writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { FeishuBotConfig } from "./types.ts";

export const CONFIG_DIR = join(homedir(), ".pi", "agent", "feishu-bot");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
/** 会话路由表：飞书 chatId → 绑定的 pi 会话文件绝对路径（持久化） */
export const BINDINGS_FILE = join(CONFIG_DIR, "bindings.json");
/** 实例注册表目录：instances/{pid}.json（心跳续约，死实例自动清理） */
export const INSTANCES_DIR = join(CONFIG_DIR, "instances");
/** 网关锁：gateway.lock {pid, heartbeat} */
export const GATEWAY_LOCK = join(CONFIG_DIR, "gateway.lock");
/** 跨实例投递信箱：inbox/{pid}/{messageId}.json */
export const INBOX_ROOT = join(CONFIG_DIR, "inbox");
export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 45_000;

async function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await chmod(CONFIG_DIR, 0o700).catch(() => {});
  }
}

// ---- 凭据 ----

export async function loadConfig(): Promise<FeishuBotConfig | null> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    if (cfg.appId && cfg.appSecret) return cfg;
  } catch (e) {
    void e; // 无配置/损坏 → 视为未配置
  }
  return null;
}

export async function saveConfig(cfg: FeishuBotConfig) {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  await chmod(CONFIG_FILE, 0o600).catch(() => {});
}

export async function deleteConfig() {
  try {
    await unlink(CONFIG_FILE);
  } catch (e) {
    void e; // 文件不存在即成功
  }
}

// ---- 会话路由绑定表（v2：聊天级 + 发送方级三元绑定） ----

export interface BindingTable {
  /** 聊天级：chatId → 会话文件（整个聊天的消息都路由到该会话） */
  chats: Record<string, string>;
  /** 发送方级："chatId|senderId" → 会话文件（同群不同人各自绑不同会话） */
  senders: Record<string, string>;
}

/** 读绑定表；v1 平面格式（chatId → path）自动迁移为 v2 chats 层 */
export async function readBindings(): Promise<BindingTable> {
  try {
    const raw = JSON.parse(await readFile(BINDINGS_FILE, "utf8"));
    if (raw && (raw.chats || raw.senders)) {
      return { chats: raw.chats || {}, senders: raw.senders || {} };
    }
    if (raw && typeof raw === "object") return { chats: raw, senders: {} };
  } catch (e) {
    void e; // 无绑定表/损坏 → 空表
  }
  return { chats: {}, senders: {} };
}

/** 绑定表实时读盘（多实例下另一实例写入立即生效） */
export async function freshBindings(): Promise<BindingTable> {
  return readBindings();
}

export async function saveBindings(table: BindingTable) {
  await ensureConfigDir();
  await writeFile(BINDINGS_FILE, JSON.stringify(table, null, 2));
}

// ---- 已登录 providers（auth.json 的 key 集，不含密钥） ----

export async function readLoggedInProviders(): Promise<string[]> {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    return Object.keys(auth || {}).filter((k) => (auth as any)[k]?.key);
  } catch (e) {
    void e; // 无 auth.json → 无登录信息
    return [];
  }
}

// ---- bai 登录模型目录（pi-bai 扩展的缓存） ----

export async function readBaiCatalogIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const cacheFile = join(homedir(), ".pi", "agent", "bai-models-cache.json");
    const cache = JSON.parse(await readFile(cacheFile, "utf8"));
    for (const acc of Object.values(cache?.accounts || {})) {
      for (const id of (acc as any)?.ids || []) ids.add(String(id));
    }
  } catch (e) {
    void e; // 无缓存 → 空目录
  }
  return ids;
}

// ---- settings.json（defaultModel 持久化） ----

export async function updateDefaultModel(modelId: string) {
  const settingsFile = join(homedir(), ".pi", "agent", "settings.json");
  let s: any;
  try {
    s = JSON.parse(await readFile(settingsFile, "utf8"));
  } catch (e) {
    void e; // settings 损坏/缺失 → 从空对象重建（只丢 defaultModel，可接受）
    s = {};
  }
  s.defaultModel = modelId;
  await writeFile(settingsFile, JSON.stringify(s, null, 2));
}
