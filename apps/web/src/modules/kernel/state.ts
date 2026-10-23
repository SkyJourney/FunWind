import { cache } from "react";
import { moduleState } from "@funwind/db";
import { withDb } from "@funwind/db";
import { getModules } from "./registry.js";

/**
 * 模块启用状态：module_state 行覆盖「默认启用」。
 * cache() = 请求级缓存（RSC 一次请求内只查一次库）。
 */

export interface ModuleEnablement {
  enabledIds: ReadonlySet<string>;
  disabledIds: ReadonlySet<string>;
}

async function loadEnablement(): Promise<ModuleEnablement> {
  const allIds = getModules().map((m) => m.id);
  let overrides: { moduleId: string; enabled: boolean }[] = [];
  try {
    await withDb(async ({ db }) => {
      const rows = await db.select().from(moduleState);
      overrides = rows.map((r) => ({ moduleId: r.moduleId, enabled: r.enabled }));
    });
  } catch (e) {
    // 库不可达时按全启用降级（内核不因平台表故障拖垮宿主页）
    console.error("[kernel] module_state 读取失败，按默认启用降级:", e);
    return { enabledIds: new Set(allIds), disabledIds: new Set() };
  }
  const overrideMap = new Map(overrides.map((r) => [r.moduleId, r.enabled]));
  const enabledIds = new Set<string>();
  const disabledIds = new Set<string>();
  for (const id of allIds) {
    const on = overrideMap.get(id) ?? true;
    (on ? enabledIds : disabledIds).add(id);
  }
  return { enabledIds, disabledIds };
}

/** 请求级缓存版本 */
export const getEnablement = cache(loadEnablement);

export async function getEnabledModuleIds(): Promise<ReadonlySet<string>> {
  return (await getEnablement()).enabledIds;
}

/** 装卸写入口（modules:toggle 脚本 / dev API / M9 管理后台共用） */
export async function setModuleEnabled(moduleId: string, enabled: boolean): Promise<void> {
  await withDb(async ({ db }) => {
    await db
      .insert(moduleState)
      .values({ moduleId, enabled, updatedAt: new Date() })
      .onDuplicateKeyUpdate({ set: { enabled, updatedAt: new Date() } });
  });
}
