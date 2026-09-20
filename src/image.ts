/**
 * image.ts — 机器人图片发送（v2.5.0）
 *
 * 链路：本地上传 im/v1/images 拿 image_key → im/v1/messages (msg_type=image)
 * 凭据与文本发送同源（config.json 的 appId/appSecret → tenant_access_token），
 * 飞书收/发分离：任何实例（含无 WS 的工作实例）都可直发，无需委托网关。
 *
 * 参考：飞书开放平台《自定义机器人使用指南》《发送图片消息》
 * - 图片限制：≤10MB，支持 png/jpeg/gif/bmp/webp 等（image_type=message）
 * - tenant_access_token 有效期 2h，这里按剩余寿命 <5min 判过期并缓存复用
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { BotRuntime } from "./types.ts";
import { loadConfig } from "./storage.ts";
import { currentSessionFile } from "./instances.ts";

const FEISHU_API = "https://open.feishu.cn/open-apis";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 官方上限 10MB
const ALLOWED_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".ico",
  ".tiff",
  ".tif",
]);

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getTenantToken(rt: BotRuntime): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const cfg = await loadConfig();
  if (!cfg?.appId || !cfg?.appSecret) {
    throw new Error("未配置飞书应用凭据（config.json 缺 appId/appSecret）");
  }
  const res = await fetch(
    `${FEISHU_API}/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    },
  );
  const data: any = await res.json().catch(() => ({}));
  if (data?.code !== 0 || !data?.tenant_access_token) {
    throw new Error(
      `获取 tenant_access_token 失败: code=${data?.code} ${data?.msg || ""}`,
    );
  }
  // 提前 5 分钟过期，避免边界竞态
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + Math.max((data.expire || 7200) * 1000 - 300_000, 0),
  };
  return tokenCache.token;
}

/** 上传本地图片 → image_key（失败抛错，含飞书 code/msg） */
export async function uploadImage(
  rt: BotRuntime,
  filePath: string,
): Promise<string> {
  const st = await stat(filePath).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`文件不存在: ${filePath}`);
  if (st.size > MAX_IMAGE_BYTES)
    throw new Error(
      `图片 ${(st.size / 1048576).toFixed(1)}MB 超过飞书 10MB 上限`,
    );
  const ext = basename(filePath).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  if (ext && !ALLOWED_EXT.has(ext))
    throw new Error(`不支持的图片格式 ${ext}（支持 png/jpg/gif/bmp/webp 等）`);

  const buf = await readFile(filePath);
  const token = await getTenantToken(rt);
  const form = new FormData();
  form.append("image_type", "message");
  form.append(
    "image",
    new Blob([new Uint8Array(buf)], { type: "application/octet-stream" }),
    basename(filePath),
  );
  const res = await fetch(`${FEISHU_API}/im/v1/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data: any = await res.json().catch(() => ({}));
  if (data?.code !== 0 || !data?.data?.image_key) {
    throw new Error(`上传失败: code=${data?.code} ${data?.msg || res.status}`);
  }
  return data.data.image_key as string;
}

/** 发送图片消息（须先 uploadImage 拿 image_key） */
export async function sendImageByKey(
  rt: BotRuntime,
  chatId: string,
  imageKey: string,
): Promise<string /* messageId */> {
  const token = await getTenantToken(rt);
  const res = await fetch(
    `${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      }),
    },
  );
  const data: any = await res.json().catch(() => ({}));
  // 飞书业务错误在 body.code；HTTP 层错误兜底
  if (data?.code !== 0) {
    throw new Error(`发送失败: code=${data?.code} ${data?.msg || res.status}`);
  }
  return data?.data?.message_id || "";
}

/** 一条龙：本地图片文件 → 飞书聊天 */
export async function sendImageToChat(
  rt: BotRuntime,
  chatId: string,
  filePath: string,
): Promise<string> {
  const key = await uploadImage(rt, filePath);
  return sendImageByKey(rt, chatId, key);
}

/**
 * 反查「绑定到本实例当前会话」的聊天 id。
 * 绑定表是 chatId → sessionPath 的正向映射，这里反向扫描；
 * 多个聊天绑到同一会话时取最新绑定（后写胜出，与绑定表语义一致）。
 */
export function findBoundChatId(rt: BotRuntime): string | null {
  const cur = currentSessionFile(rt);
  if (!cur) return null;
  let hit: string | null = null;
  for (const [chatId, path] of Object.entries(rt.chatBindings)) {
    if (path === cur) hit = chatId;
  }
  return hit;
}
