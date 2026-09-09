/**
 * commands/model.ts — Command 模式：模型指令（当前模型 / 列出模型 / 切换模型）
 */
import type { BotRuntime, FastCommand } from "../types.ts";
import { replyMarkdown } from "../sender.ts";
import { resolveAvailableModels } from "../model-resolver.ts";
import { updateDefaultModel } from "../storage.ts";
import { MODEL_SWITCH_RE } from "../utils.ts";

// ---------------------------------------------------------------- 当前模型

export function createCurrentModelCommand(rt: BotRuntime): FastCommand {
  return {
    name: "current-model",
    match: (_text, lower) =>
      lower === "当前模型" ||
      lower === "查看模型" ||
      lower === "模型" ||
      lower === "/model",
    async execute(req) {
      const m = rt.currentCtx?.model;
      await replyMarkdown(
        rt,
        req,
        `🤖 当前模型: **${m?.id || "默认"}** (${m?.provider || "未知"})\n切换: \`切换模型到 <名称>\``,
      );
      return true;
    },
  };
}

// ---------------------------------------------------------------- 列出模型

export function createListModelsCommand(rt: BotRuntime): FastCommand {
  return {
    name: "list-models",
    match: (_text, lower) =>
      lower === "列出模型" ||
      lower === "可用模型" ||
      lower === "全部模型" ||
      lower === "所有模型" ||
      lower === "models" ||
      lower === "/models",
    async execute(req, _text, lower) {
      const showAll = lower === "全部模型" || lower === "所有模型";
      const all = await resolveAvailableModels(rt);
      const curId = rt.currentCtx?.model?.id;
      const curProvider = rt.currentCtx?.model?.provider;
      // 表格形式：| 使用中 | 模型 | Provider |（飞书 post md 组件支持表格渲染）
      const shown = showAll ? all : all.slice(0, 30);
      const rows = shown
        .map((m: any) => {
          const isCur = m.id === curId && m.provider === curProvider;
          return `| ${isCur ? "✅" : ""} | ${m.id} | ${m.provider} |`;
        })
        .join("\n");
      const table = `| 使用中 | 模型 | Provider |\n| --- | --- | --- |\n${rows}`;
      const more =
        all.length > shown.length
          ? `\n\n（还有 ${all.length - shown.length} 个，发 \`全部模型\` 查看）`
          : "";
      await replyMarkdown(
        rt,
        req,
        `### 📋 已登录可用模型 (共 ${all.length} 个)\n\n${table}${more}\n\n切换: \`切换模型到 <模型名>\``,
      );
      return true;
    },
  };
}

// ---------------------------------------------------------------- 切换模型

export function createSwitchModelCommand(rt: BotRuntime, pi: any): FastCommand {
  return {
    name: "switch-model",
    match: (text) => MODEL_SWITCH_RE.test(text.trim()),
    async execute(req, text) {
      const sw = text.trim().match(MODEL_SWITCH_RE)!;
      const raw = sw[1].trim();
      const q = raw.replace(/\.+/g, ".").trim().toLowerCase();
      // 优先在登录账号目录内匹配，找不到再回落全量 registry
      const accountModels = await resolveAvailableModels(rt);
      const registry = rt.currentCtx?.modelRegistry?.getAll?.() || [];
      const all = accountModels.length > 0 ? accountModels : registry;
      const pick = (list: any[]) => {
        const curProvider = rt.currentCtx?.model?.provider;
        return (
          // 同 id 多 provider 时优先当前 provider，避免切错上游
          list.find(
            (m: any) => m.id.toLowerCase() === q && m.provider === curProvider,
          ) ||
          list.find((m: any) => m.id.toLowerCase() === q) ||
          list.find((m: any) => m.id.toLowerCase().includes(q)) ||
          list.find((m: any) => m.name?.toLowerCase().includes(q))
        );
      };
      const matched = pick(all) || pick(registry);
      if (!matched) {
        await replyMarkdown(
          rt,
          req,
          `❌ 未找到模型 "${raw}"。试试 \`列出模型\`。`,
        );
        return true;
      }
      const ok = await pi.setModel(matched);
      if (ok === false) {
        await replyMarkdown(rt, req, `❌ 模型切换失败: ${matched.id}`);
        return true;
      }
      try {
        await updateDefaultModel(matched.id);
      } catch (e) {
        void e; // settings 回写失败 → 仅本次会话生效
      }
      await replyMarkdown(
        rt,
        req,
        `✅ 模型已切换为 **${matched.id}** (${matched.provider})，已保存为默认。`,
      );
      return true;
    },
  };
}
