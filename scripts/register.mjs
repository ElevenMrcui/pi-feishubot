/**
 * pi-feishubot 注册脚本 — 扫码创建飞书应用，凭据自动写入 pi 配置
 *
 * 用法: node ~/.pi/agent/feishubot/register.mjs
 * 流程: 终端显示二维码 URL → 用户飞书扫码确认 → 自动拿到 appId/appSecret
 *       → 写入 ~/.pi/agent/feishu-bot/config.json → 重启 pi 即连接
 */
import { registerApp } from "@larksuite/channel";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import QRCode from "qrcode";

const CONFIG_DIR = join(homedir(), ".pi", "agent", "feishu-bot");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const APP_PRESET = {
  name: "pi-remote",
  description:
    "pi coding agent 飞书遥控入口：发消息驱动 AI 编码助手，流式查看执行进度",
};

const STATUS_TEXT = {
  pending: "⏳ 等待扫码...",
  approved: "✅ 已授权，正在获取凭据...",
  slow_down: "🐢 轮询过快，自动降速...",
  expired_token: "⌛ 二维码已过期，重新生成中...",
};

console.log("=== pi 飞书机器人注册 ===\n");

try {
  const result = await registerApp({
    appPreset: APP_PRESET,
    source: "pi-feishubot",
    onQRCodeReady: ({ url }) => {
      console.log("请用【飞书 App】扫描下方二维码（扫码 → 确认创建应用）：\n");
      // 终端 ASCII 二维码
      QRCode.toString(url, { type: "terminal", small: true }, (err, s) => {
        if (!err) console.log(s);
      });
      console.log(`二维码链接（手机浏览器打开也可）:\n${url}\n`);
      console.log("等待授权中（10 分钟内有效）...");
    },
    onStatusChange: (s) => {
      const text = STATUS_TEXT[s.status] || `状态: ${s.status}`;
      console.log(text);
    },
  });

  console.log("\n🎉 应用创建成功!");
  console.log(`App ID: ${result.client_id}`);

  await mkdir(CONFIG_DIR, { recursive: true });
  await chmod(CONFIG_DIR, 0o700).catch(() => {});
  await writeFile(
    CONFIG_FILE,
    JSON.stringify(
      {
        appId: result.client_id,
        appSecret: result.client_secret,
        name: APP_PRESET.name,
      },
      null,
      2,
    ),
  );
  await chmod(CONFIG_FILE, 0o600).catch(() => {});
  console.log(`凭据已写入: ${CONFIG_FILE}`);
  console.log("\n下一步: 重启 pi 或执行 /reload，飞书机器人自动上线");
  console.log("提示: 单聊机器人直接发消息即可；群里需要 @机器人");
  process.exit(0);
} catch (e) {
  console.error("\n❌ 注册失败:", e.message);
  process.exit(1);
}
