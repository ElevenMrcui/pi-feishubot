/**
 * sdk.ts — Lark Channel SDK 加载（Factory + 单例）
 *
 * jiti 环境下用 createRequire 解析独立目录的 SDK（不污染 pi 托管的 npm 目录）：
 * 优先扩展旁路 require，回落 ~/.pi/agent/feishubot/node_modules。
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const nodeRequire = createRequire(import.meta.url);
const SDK_DIR = join(homedir(), ".pi", "agent", "feishubot");

function loadSDK(): any {
  const candidates: Array<() => any> = [
    () => nodeRequire("@larksuite/channel"),
    () => nodeRequire(join(SDK_DIR, "node_modules", "@larksuite/channel")),
  ];
  for (const load of candidates) {
    try {
      const m = load();
      if (m?.createLarkChannel) return m;
    } catch (e) {
      void e; // 候选路径缺失 → 尝试下一个
    }
  }
  return null;
}

const SDK = loadSDK();
if (!SDK) {
  console.error(
    "[feishubot] @larksuite/channel 加载失败。执行: cd ~/.pi/agent/feishubot && npm install @larksuite/channel",
  );
}

export const createLarkChannel: any = SDK?.createLarkChannel;
export const LarkChannelError: any = SDK?.LarkChannelError;
export function isSDKAvailable(): boolean {
  return !!SDK;
}
