import "server-only";

import { eq, sql } from "drizzle-orm";
import { themePackages } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { invalidateSiteChrome } from "@/lib/chrome/site-chrome";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import {
  auditRevisionChange,
  lockThemeCapacity,
  lockThemePack,
  MAX_ENABLED_THEME_PACKS,
  themeCapacityReached,
} from "./pack-write-core";

/**
 * 管理 REST 主题包写入的准备、加锁和执行阶段。幂等回放在锁定目标前短路；
 * 加锁只检查存在性，版本、默认包保护和容量裁决留到执行阶段。
 * 幂等管线在取得默认包行锁前只有加锁读，随后启用计数是事务首次一致性读，
 * 因此能看到前序持锁事务的提交。主题包变更与审计同事务，目录缓存提交后才失效。
 */

/** REST 元数据的长度与 theme_packages 列定义一致，不截断超限输入。 */
export const THEME_PACK_NAME_MAX = 60;
export const THEME_PACK_DESCRIPTION_MAX = 200;

/** REST 变体可触达的业务拒绝码。 */
export type ThemeApiErrorCode =
  | "bad-name"
  | "bad-description"
  | "not-found"
  | "conflict"
  | "protected"
  | "enabled-limit"
  | "capacity-unavailable";

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const THEMES_DENIAL_HTTP = {
  "bad-name": "bad_request",
  "bad-description": "bad_request",
  "not-found": "not_found",
  conflict: "state_conflict",
  protected: "state_conflict",
  "enabled-limit": "state_conflict",
  "capacity-unavailable": "state_conflict",
} as const;

/** REST 审计的 API 追踪字段（仅传入 trace 时附加，后台审计形态不变）。 */
const themeTraceFields = (trace?: ModerationApiTrace) =>
  trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {};

/** REST 三段式写变体的准备产物类型（data 为写响应载荷，denial 复用域拒绝码）。 */
export type PreparedApiThemePackWrite = PreparedModerationWrite<
  { id: string; revision: number; enabled?: boolean; changed?: boolean },
  ThemeApiErrorCode
>;

/**
 * REST 编辑主题包（PATCH /api/manage/themes/{id}，M20.3 Step 5）：
 * lock 段只做存在性锁（default 行 → 目标行，缺 default → capacity-unavailable、缺目标 → not-found）；
 * 执行阶段复核名称和描述长度，以及 revision 冲突；省略的元数据字段原样保留。
 * 不触碰 definition/assets（仅 name/description + revision），审计走 theme.pack.update。
 */
export async function prepareApiThemePackUpdate(
  actor: ConfigActor,
  id: string,
  expectedRevision: number,
  input: { name?: string; description?: string },
  trace?: ModerationApiTrace,
): Promise<PreparedApiThemePackWrite | ModerationWriteDenial<ThemeApiErrorCode>> {
  return {
    ok: true,
    async lock(tx) {
      if (!(await lockThemeCapacity(tx))) {
        return { ok: false as const, code: "capacity-unavailable" as const };
      }
      const row = await lockThemePack(tx, id);
      if (!row) return { ok: false as const, code: "not-found" as const };
      return {
        ok: true as const,
        async execute() {
          const name = input.name?.trim();
          if (name !== undefined && (name.length === 0 || name.length > THEME_PACK_NAME_MAX)) {
            return { ok: false as const, code: "bad-name" as const };
          }
          const description = input.description?.trim();
          if (description !== undefined && description.length > THEME_PACK_DESCRIPTION_MAX) {
            return { ok: false as const, code: "bad-description" as const };
          }
          if (row.revision !== expectedRevision) {
            return { ok: false as const, code: "conflict" as const, message: "版本已变化" };
          }
          const nextName = name ?? row.name;
          const nextDescription = description ?? row.description;
          await tx
            .update(themePackages)
            .set({
              name: nextName,
              description: nextDescription,
              revision: row.revision + 1,
              updatedAt: sql`NOW()`,
            })
            .where(eq(themePackages.id, id));
          const updated = (await lockThemePack(tx, id))!;
          await auditRevisionChange(
            tx,
            actor,
            "theme.pack.update",
            id,
            row.revision,
            { name: row.name, description: row.description },
            updated.revision,
            { name: nextName, description: nextDescription, ...themeTraceFields(trace) },
          );
          return {
            ok: true as const,
            data: { id, revision: updated.revision },
            async afterCommit() {
              invalidateThemeCatalog();
            },
          };
        },
      };
    },
  };
}

/**
 * REST 启停主题包（POST /api/manage/themes/{id}/enabled，M20.3 Step 5）：
 * default 不可停用（protected）与容量上限（enabled-limit）裁决在 execute；
 * 同值幂等返回 changed:false 且零写入零审计（后台同值也只回读不写）。
 */
export async function prepareApiThemePackEnabled(
  actor: ConfigActor,
  id: string,
  enabled: boolean,
  trace?: ModerationApiTrace,
): Promise<PreparedApiThemePackWrite | ModerationWriteDenial<ThemeApiErrorCode>> {
  return {
    ok: true,
    async lock(tx) {
      if (!(await lockThemeCapacity(tx))) {
        return { ok: false as const, code: "capacity-unavailable" as const };
      }
      const row = await lockThemePack(tx, id);
      if (!row) return { ok: false as const, code: "not-found" as const };
      return {
        ok: true as const,
        async execute() {
          // 与后台一致，依次检查默认包保护、同值和启用容量。
          if (!enabled && id === "default") {
            return {
              ok: false as const,
              code: "protected" as const,
              message: "default 是系统回退包，不可停用",
            };
          }
          if (row.enabled === enabled) {
            return {
              ok: true as const,
              data: { id, revision: row.revision, enabled, changed: false },
            };
          }
          if (enabled && (await themeCapacityReached(tx))) {
            return {
              ok: false as const,
              code: "enabled-limit" as const,
              message: `启用中的主题包已达上限 ${MAX_ENABLED_THEME_PACKS}`,
            };
          }
          await tx
            .update(themePackages)
            .set({ enabled, revision: row.revision + 1, updatedAt: sql`NOW()` })
            .where(eq(themePackages.id, id));
          const updated = (await lockThemePack(tx, id))!;
          await auditRevisionChange(
            tx,
            actor,
            "theme.pack.toggle",
            id,
            row.revision,
            { enabled: row.enabled },
            updated.revision,
            { enabled, ...themeTraceFields(trace) },
          );
          return {
            ok: true as const,
            data: { id, revision: updated.revision, enabled, changed: true },
            async afterCommit() {
              // 先刷新目录，再让站点默认主题和主题排期按新目录重新判定。
              invalidateThemeCatalog();
              invalidateSiteChrome();
            },
          };
        },
      };
    },
  };
}
