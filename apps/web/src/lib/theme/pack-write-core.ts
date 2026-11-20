import "server-only";

import { count, eq } from "drizzle-orm";
import { themePackages } from "@funwind/db";
import { writeAudit, type ConfigActor, type DbTx } from "@/lib/audit";

/** 全站启用包总数上限，包含内置包；停用包仍可保留和编辑。 */
export const MAX_ENABLED_THEME_PACKS = 5;

export type ThemePackRow = typeof themePackages.$inferSelect;

/** 在调用方事务内锁住指定主题包；不存在时返回 null。 */
export async function lockThemePack(tx: DbTx, id: string): Promise<ThemePackRow | null> {
  const [row] = await tx
    .select()
    .from(themePackages)
    .where(eq(themePackages.id, id))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** 启用容量变更统一先锁不可删除的 default，再锁目标包，避免并发计数突破上限。 */
export async function lockThemeCapacity(tx: DbTx): Promise<boolean> {
  return (await lockThemePack(tx, "default")) !== null;
}

/** 在调用方持有容量锁时检查启用包数量是否已达上限。 */
export async function themeCapacityReached(tx: DbTx): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: count() })
    .from(themePackages)
    .where(eq(themePackages.enabled, true));
  return Number(row.enabled) >= MAX_ENABLED_THEME_PACKS;
}

/** 在主题包变更所在的事务内记录操作人、目标和变更内容。 */
export async function auditThemePackChange(
  tx: DbTx,
  actor: ConfigActor,
  action: string,
  id: string,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  await writeAudit(tx, {
    actorId: actor.userId,
    action,
    targetType: "theme_pack",
    targetId: id,
    before,
    after,
    ip: actor.ip,
  });
}

/** 将变更前后的版本号一并写入主题包审计。 */
export async function auditRevisionChange(
  tx: DbTx,
  actor: ConfigActor,
  action: string,
  id: string,
  beforeRevision: number,
  before: Record<string, unknown>,
  afterRevision: number,
  after: Record<string, unknown>,
): Promise<void> {
  await auditThemePackChange(
    tx,
    actor,
    action,
    id,
    { ...before, revision: beforeRevision },
    { ...after, revision: afterRevision },
  );
}
