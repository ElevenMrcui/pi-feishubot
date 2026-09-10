/**
 * commands/model.ts — Command 模式：模型指令（当前模型 / 列出模型 / 切换模型）
 *
 * 用户规范（v2.2.0）：
 * - 列表行格式：`模型名-厂商`（如 glm-5.3-flash-zai-coding-cn），✅ 标当前
 * - 切换寻址：`切换模型 glm-5.3-flash-zai-coding-cn`（后缀-厂商）
 *            / `切换模型 glm-5.3-flash [zai-coding-cn]`（括号）
 *            / `切换模型 glm-5.3-flash zai-coding-cn`（空格）
 *            / `切换模型 glm-5.3-flash`（仅 id，当前厂商优先）
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
      lower === "/model" ||
      lower === "当前模型是否可用" ||
      lower === "模型可用" ||
      /模型.*(可用|正常|在线)$/.test(lower),
    async execute(req) {
      const m = rt.currentCtx?.model;
      // 可用性最直接证据：本回复即由当前模型生成
      await replyMarkdown(
        rt,
        req,
        `🤖 当前模型: **${m?.id || "默认"}-${m?.provider || "未知"}**\n✅ 可用（本条回复即由它生成）\n切换: \`切换模型 模型名-厂商\`（可从 \`模型列表\` 直接复制）`,
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
      lower === "模型列表" ||
      lower === "模型清单" ||
      lower === "全部模型" ||
      lower === "所有模型" ||
      lower === "models" ||
      lower === "/models",
    async execute(req, _text, lower) {
      const showAll = lower === "全部模型" || lower === "所有模型";
      const all = await resolveAvailableModels(rt);
      const curId = rt.currentCtx?.model?.id;
      const curProvider = rt.currentCtx?.model?.provider;
      // 用户规范格式：模型名-厂商（可直接复制用于 切换模型）
      const shown = showAll ? all : all.slice(0, 30);
      const rows = shown
        .map((m: any) => {
          const isCur = m.id === curId && m.provider === curProvider;
          return `| ${isCur ? "✅" : ""} | ${m.id}-${m.provider} |`;
        })
        .join("\n");
      const table = `| 使用中 | 模型-厂商 |\n| --- | --- |\n${rows}`;
      const more =
        all.length > shown.length
          ? `\n\n（还有 ${all.length - shown.length} 个，发 \`全部模型\` 查看）`
          : "";
      await replyMarkdown(
        rt,
        req,
        `### 📋 已登录可用模型 (共 ${all.length} 个)\n\n${table}${more}\n\n切换: \`切换模型 模型名-厂商\`（从上表直接复制）`,
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
      const all = await resolveAvailableModels(rt);
      const registry = rt.currentCtx?.modelRegistry?.getAll?.() || [];
      const universe = all.length > 0 ? all : registry;
      const knownProviders = [
        ...new Set(universe.map((m: any) => String(m.provider).toLowerCase())),
      ].sort((a, b) => b.length - a.length); // 长厂商名优先匹配

      // ① 括号形态：<id> [provider]
      let modelPart = raw;
      let wantProvider = "";
      const bracket = raw.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
      if (bracket) {
        modelPart = bracket[1].trim();
        wantProvider = bracket[2].trim().toLowerCase();
      } else {
        // ② 空格形态：<id> <provider>（末段命中已知厂商）
        const parts = raw.split(/\s+/);
        if (parts.length >= 2) {
          const last = parts[parts.length - 1].toLowerCase();
          if (knownProviders.includes(last)) {
            wantProvider = last;
            modelPart = parts.slice(0, -1).join(" ").trim();
          }
        }
        // ③ 后缀形态：<id>-<provider>（长厂商名优先，避免 zai-coding-cn 被截断）
        if (!wantProvider) {
          const low = raw.toLowerCase();
          for (const p of knownProviders) {
            if (low.endsWith("-" + p)) {
              wantProvider = p;
              modelPart = raw.slice(0, raw.length - p.length - 1).trim();
              break;
            }
          }
        }
      }

      const q = modelPart.replace(/\.+/g, ".").trim().toLowerCase();
      const pick = (list: any[]) => {
        const cur = rt.currentCtx?.model?.provider;
        return (
          (wantProvider &&
            list.find(
              (m: any) =>
                m.id.toLowerCase() === q &&
                String(m.provider).toLowerCase() === wantProvider,
            )) ||
          list.find((m: any) => m.id.toLowerCase() === q) ||
          list.find(
            (m: any) =>
              m.id.toLowerCase().includes(q) &&
              (!wantProvider ||
                String(m.provider).toLowerCase() === wantProvider),
          ) ||
          list.find((m: any) => m.id.toLowerCase().includes(q)) ||
          list.find((m: any) => m.name?.toLowerCase().includes(q))
        );
      };
      const matched = pick(universe) || pick(registry);
      if (!matched) {
        await replyMarkdown(
          rt,
          req,
          `❌ 未找到模型 "${raw}"。试试 \`列出模型\`（支持 \`切换模型 模型名-厂商\`）。`,
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
        `✅ 已切换 **${matched.id}-${matched.provider}**，已保存为默认。`,
      );
      return true;
    },
  };
}
