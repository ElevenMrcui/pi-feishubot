/**
 * commands/index.ts — Command 模式：指令注册表（Registry + Factory）
 *
 * createCommandRegistry(rt, pi) 按固定优先级装配全部指令；
 * find(text) 返回首个匹配的指令（顺序敏感：精确匹配优先于正则匹配）。
 */
import type { BotRuntime, FastCommand } from "../types.ts";
import {
  createHelpCommand,
  createNewSessionCommand,
  createStatusCommand,
  createStopCommand,
} from "./basic.ts";
import {
  createCurrentModelCommand,
  createListModelsCommand,
  createSwitchModelCommand,
} from "./model.ts";
import {
  createBindMeCommand,
  createBindSessionCommand,
  createSessionsCommand,
  createSwitchSessionCommand,
  createUnbindMeCommand,
  createUnbindSessionCommand,
} from "./session.ts";
import {
  createInstancesCommand,
  createKillInstanceCommand,
  createResumeSessionCommand,
  createSpawnInstanceCommand,
} from "./instances.ts";
import { createReloadCommand } from "./reload.ts";

export interface CommandRegistry {
  /** 全部指令（按优先级排列） */
  commands: FastCommand[];
  /** 首个匹配的指令；无匹配返回 null */
  find(text: string): FastCommand | null;
  /** 是否存在匹配的快捷指令 */
  matchesAny(text: string): boolean;
  /** 执行匹配的指令；异常统一兜底回执。返回是否已消费 */
  execute(
    req: import("../types.ts").FeishuRequest,
    text: string,
  ): Promise<boolean>;
}

export function createCommandRegistry(
  rt: BotRuntime,
  pi: any,
): CommandRegistry {
  // 顺序敏感：精确匹配的指令在正则匹配的指令之前
  // （如 current-model 精确匹配 `/model`，必须先于 switch-model 的 `/model X`）
  const commands: FastCommand[] = [
    createHelpCommand(rt),
    createStopCommand(rt),
    createStatusCommand(rt),
    createNewSessionCommand(rt, pi),
    createCurrentModelCommand(rt),
    createListModelsCommand(rt),
    createSwitchModelCommand(rt, pi),
    createSpawnInstanceCommand(rt),
    createResumeSessionCommand(rt),
    createKillInstanceCommand(rt),
    createReloadCommand(rt, pi),
    createInstancesCommand(rt),
    createSessionsCommand(rt),
    createSwitchSessionCommand(rt, pi),
    createBindSessionCommand(rt),
    createUnbindSessionCommand(rt),
    createBindMeCommand(rt),
    createUnbindMeCommand(rt),
  ];

  function find(text: string): FastCommand | null {
    const lower = text.trim().toLowerCase();
    for (const cmd of commands) {
      try {
        if (cmd.match(text.trim(), lower)) return cmd;
      } catch (e) {
        void e; // 单个指令匹配异常 → 继续尝试后续指令
      }
    }
    return null;
  }

  return {
    commands,
    find,
    matchesAny: (text: string) => find(text) !== null,
    async execute(req, text) {
      const cmd = find(text);
      if (!cmd) return false;
      try {
        return await cmd.execute(req, text, text.trim().toLowerCase());
      } catch (e: any) {
        const { replyMarkdown } = await import("../sender.ts");
        await replyMarkdown(rt, req, `❌ 指令执行失败: ${e?.message || e}`);
        return true; // 已兜底回执，视为消费
      }
    },
  };
}
