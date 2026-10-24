import { cache } from "react";
import { eq } from "drizzle-orm";
import { getWebDb, moduleState } from "@funwind/db";
import { CLI_ACTOR, writeAudit, type ConfigActor } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import { getModules } from "./registry";

/**
 * 模块启用状态：module_state 行覆盖「默认启用」。
 * cache() = 请求级缓存（RSC 一次请求内只查一次库）；连接走 getWebDb 单例池（基线审查 P1-1）。
 */

export interface ModuleEnablement {
  enabledIds: ReadonlySet<string>;
  disabledIds: ReadonlySet<string>;
}

async function loadEnablement(): Promise<ModuleEnablement> {
  const allIds = getModules().map((m) => m.id);
  let overrides: { moduleId: string; enabled: boolean }[] = [];
  try {
    const db = getWebDb();
    const rows = await db.select().from(moduleState);
    overrides = rows.map((r) => ({ moduleId: r.moduleId, enabled: r.enabled }));
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

/**
 * 装卸写入口（modules:toggle 脚本 / dev API / M9 管理后台共用）。
 * 启停是管理动作：状态真正变化时同事务写 audit_log（谁/何时/哪个模块/前后状态）；
 * 重复设置为当前状态是幂等空操作，不写审计。没有 module_state 行时默认启用。
 */
export async function setModuleEnabled(
  moduleId: string,
  enabled: boolean,
  actor: ConfigActor = CLI_ACTOR,
): Promise<void> {
  await getWebDb().transaction(async (tx) => {
    const [prev] = await tx
      .select({ enabled: moduleState.enabled })
      .from(moduleState)
      .where(eq(moduleState.moduleId, moduleId))
      .for("update");
    const was = prev?.enabled ?? true;
    await tx
      .insert(moduleState)
      .values({ moduleId, enabled, updatedAt: nowBeijingWallTime() })
      .onDuplicateKeyUpdate({ set: { enabled, updatedAt: nowBeijingWallTime() } });
    if (was !== enabled) {
      await writeAudit(tx, {
        actorId: actor.userId,
        action: enabled ? "module.enable" : "module.disable",
        targetType: "module",
        targetId: moduleId,
        before: { enabled: was },
        after: { enabled, via: actor.via },
        ip: actor.ip,
      });
    }
  });
}
