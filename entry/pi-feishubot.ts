/**
 * pi-feishubot — 扩展入口（包内布局版本）
 *
 * 本文件是 npm/git 安装形态的入口（与 src/ 同级）：
 *   <安装目录>/entry/pi-feishubot.ts → import "../src/main.ts"
 *
 * 另有散装布局入口（复制到 ~/.pi/agent/extensions/ 时使用，import "../feishubot/src/main.ts"）。
 * 两者二选一，避免同一 pi 进程双重注册。
 */
// @ts-nocheck
import main from "../src/main.ts";

export default function (pi: any) {
  return main(pi);
}
