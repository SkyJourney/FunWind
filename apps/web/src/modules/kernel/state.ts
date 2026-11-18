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
  /** 区分本次成功读取、沿用进程旧快照和冷启动降级。 */
  source: "database" | "last_known" | "unavailable";
}

export interface ModuleOverride {
  moduleId: string;
  enabled: boolean;
}

/** 上一次成功读到的覆盖表（进程内）。读库失败时沿用它，而不是把停用的模块重新打开 */
export interface EnablementMemory {
  overrides: Map<string, boolean> | null;
}
const lastKnown: EnablementMemory = { overrides: null };

/**
 * 计算启用状态。读取失败时保留页面和直接派发的降级策略（复查 B3）：有旧快照则沿用，否则全禁。
 * 同时标记结果来源，让持久派发能区分「暂时读不到状态」和「按真实配置停用」。
 */
export async function resolveEnablement(
  allIds: readonly string[],
  read: () => Promise<ModuleOverride[]>,
  memory: EnablementMemory = lastKnown,
): Promise<ModuleEnablement> {
  let overrideMap: Map<string, boolean>;
  let source: ModuleEnablement["source"] = "database";
  try {
    overrideMap = new Map((await read()).map((r) => [r.moduleId, r.enabled]));
    memory.overrides = overrideMap;
  } catch {
    if (memory.overrides) {
      console.error("[kernel] module_state_read_failed：沿用上一次成功读到的启停状态");
      source = "last_known";
      overrideMap = memory.overrides;
    } else {
      console.error("[kernel] module_state_read_failed：没有可沿用的状态，所有模块暂按停用处理");
      return { enabledIds: new Set(), disabledIds: new Set(allIds), source: "unavailable" };
    }
  }
  const enabledIds = new Set<string>();
  const disabledIds = new Set<string>();
  for (const id of allIds) {
    const on = overrideMap.get(id) ?? true;
    (on ? enabledIds : disabledIds).add(id);
  }
  return { enabledIds, disabledIds, source };
}

async function loadEnablement(): Promise<ModuleEnablement> {
  return resolveEnablement(
    getModules().map((m) => m.id),
    async () => {
      const rows = await getWebDb().select().from(moduleState);
      return rows.map((r) => ({ moduleId: r.moduleId, enabled: r.enabled }));
    },
  );
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
