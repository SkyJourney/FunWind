import "server-only";

import { eq } from "drizzle-orm";
import { getWebDb, resetToBuiltin, themePackages } from "@funwind/db";
import { writeAudit, type ConfigActor } from "@/lib/audit";
import { invalidateThemeCatalog } from "@/lib/theme/catalog";
import {
  assetsForDefinition,
  lockThemePack,
  toSummary,
  type ThemePackSummary,
} from "@/lib/theme/packs";
import { parseThemePackDefinition } from "@/lib/theme/surface-schema";

/**
 * 重置内置主题包为种子定义（M11.6 Step 3f，docs/milestones/M11.6-theme-semantic-tokens.md §3.4）。
 * 调用 packages/db 的 resetToBuiltin 原语，并在同一事务里：
 *  · 核对 revision（列表加载后别人改过就报冲突，不悄悄覆盖）；
 *  · 按重置后的定义重算 assets（保留 LOGO，装饰图重新算），否则导出 ZIP 会带上不再引用的文件；
 *  · 写审计 theme.pack.reset，before 带重置前的完整旧定义。后台日志页与 CSV 只展示 after，
 *    所以旧定义目前只能直接查库取回；界面上的留存手段是重置前先导出 ZIP。
 * 名称、说明、启停与 LOGO 不动。
 */
export type ThemePackResetResult =
  | { ok: true; value: ThemePackSummary }
  | { ok: false; code: "not-found" | "conflict" | "not-builtin" };

export async function resetThemePack(input: {
  id: string;
  expectedRevision: number;
  actor: ConfigActor;
}): Promise<ThemePackResetResult> {
  const result = await getWebDb().transaction(async (tx): Promise<ThemePackResetResult> => {
    const row = await lockThemePack(tx, input.id);
    if (!row) return { ok: false, code: "not-found" };
    if (!row.isBuiltin) return { ok: false, code: "not-builtin" };
    if (row.revision !== input.expectedRevision) return { ok: false, code: "conflict" };
    if ((await resetToBuiltin(tx, input.id)) === 0) return { ok: false, code: "not-builtin" };
    const reset = (await lockThemePack(tx, input.id))!;
    const parsed = parseThemePackDefinition(reset.definition);
    if (!parsed.ok) throw new Error(`内置种子 ${input.id} 未通过定义校验`);
    await tx
      .update(themePackages)
      .set({ assets: assetsForDefinition(reset.assets, parsed.value) })
      .where(eq(themePackages.id, input.id));
    const final = (await lockThemePack(tx, input.id))!;
    await writeAudit(tx, {
      actorId: input.actor.userId,
      action: "theme.pack.reset",
      targetType: "theme_pack",
      targetId: input.id,
      before: { revision: row.revision, definition: row.definition },
      after: { revision: final.revision },
      ip: input.actor.ip,
    });
    return { ok: true, value: toSummary(final) };
  });
  if (result.ok) invalidateThemeCatalog();
  return result;
}
