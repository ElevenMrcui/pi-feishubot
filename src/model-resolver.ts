/**
 * model-resolver.ts — Strategy 模式：可用模型解析
 *
 * 解析策略（依次回落）：
 * 1. 已登录 providers（auth.json key 集）∩ 模型注册表
 * 2. bai 目录精确化：bai 名下只保留登录目录内的 id（缓存清单是账号真实可用集）
 * 3. 回落：当前 provider 的注册表模型 → 全部注册表
 */
import type { BotRuntime } from "./types.ts";
import { readBaiCatalogIds, readLoggedInProviders } from "./storage.ts";

export async function resolveAvailableModels(rt: BotRuntime): Promise<any[]> {
 const reg: any[] = rt.currentCtx?.modelRegistry?.getAll?.() || [];

 // 1) 已登录 provider 集合
 const loggedIn = await readLoggedInProviders();
 let models = reg;
 if (loggedIn.length > 0) {
  const allow = new Set(loggedIn);
  const scoped = reg.filter((m: any) => allow.has(m.provider));
  if (scoped.length > 0) models = scoped;
 }

 // 2) bai 目录精确化（只保留账号目录内的 id）
 const ids = await readBaiCatalogIds();
 if (ids.size > 0) {
  const refined = models.filter(
   (m: any) => m.provider !== "bai" || ids.has(m.id),
  );
  if (refined.length > 0) models = refined;
 }

 if (models.length > 0) return models;

 // 3) 回落
 const cur = rt.currentCtx?.model?.provider;
 const sameProvider = cur ? reg.filter((m: any) => m.provider === cur) : [];
 return sameProvider.length > 0 ? sameProvider : reg;
}
