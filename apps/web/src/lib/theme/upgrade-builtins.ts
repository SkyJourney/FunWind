import "server-only";
import { sql } from "drizzle-orm";
import { getWebDb, themePackages } from "@funwind/db";

/**
 * 内置包升级原语（M11.6 Step 2）：backfillMissingSections / swapIfUnchanged。
 *
 * 种子表用 INSERT IGNORE 语义「按主键补缺」，已存在的行不会得到新字段，导致内置包（如 qy2010）
 * 丢失后续升级追加的顶层段（如 tokens）。这两个原语用幂等 SQL 补齐缺失段或有条件替换值。
 *
 * 背景：站长可通过后台编辑器修改内置包，我们不能无条件覆盖——只有「仍等于出厂值的字段」
 * 才自动升级，已改动的保持不动（尊重站长决策）。revision 随升级递增，触发已打开编辑页的冲突提示。
 */

/**
 * 补齐顶层段（如 tokens、pwa）：只有缺失时才补，永不覆盖已有段。
 * 同一条 UPDATE 里 revision + 1（触发编辑器冲突检测）。
 *
 * 用途：bootstrapDb 里调用，让内置包在重置库 / 安装向导 / db:bootstrap 时都得到新段。
 *
 * @param id 包 id（如 "qy2010"）
 * @param sections 要补齐的段（如 `{ tokens: { light: {...} } }`）
 * @returns 受影响行数（0 = 该包不存在或所有段已存在）
 */
export async function backfillMissingSections(
  id: string,
  sections: Record<string, unknown>,
): Promise<number> {
  const db = getWebDb();
  if (Object.keys(sections).length === 0) return 0;

  // 构造 JSON_SET 表达式：对每个段，只在路径不存在时补值
  const setExprs: ReturnType<typeof sql>[] = [];
  for (const [key, value] of Object.entries(sections)) {
    setExprs.push(
      sql`'$.${sql.raw(key)}', IF(JSON_CONTAINS_PATH(definition, 'one', ${`$.${key}`}), JSON_EXTRACT(definition, ${`$.${key}`}), ${JSON.stringify(value)})`,
    );
  }

  // 只在至少一个段缺失时才更新
  const missingConds = Object.keys(sections)
    .map((key) => sql`JSON_CONTAINS_PATH(definition, 'one', ${`$.${key}`}) = 0`)
    .reduce((a, b) => sql`${a} OR ${b}`);

  const [result] = await db
    .update(themePackages)
    .set({
      definition: sql`JSON_SET(definition, ${sql.join(setExprs, sql.raw(", "))})`,
      revision: sql`revision + 1`,
    })
    .where(sql`id = ${id} AND (${missingConds})`);

  return result?.affectedRows ?? 0;
}

/**
 * 有条件替换值：只有该路径上的值仍等于旧值才替换，已改动的跳过。
 * 同一条 UPDATE 里 revision + 1。
 *
 * 用途：品牌色微调（如 #147ba9 → 新值）——站长改过的不会被覆盖，跳过并记日志。
 *
 * @param id 包 id
 * @param jsonPath JSON 路径（如 "$.tokens.light.colors.primary"）
 * @param oldValue 旧值（如 "#147ba9"）
 * @param newValue 新值
 * @returns 受影响行数（0 = 该包不存在或值已变更）
 */
export async function swapIfUnchanged(
  id: string,
  jsonPath: string,
  oldValue: unknown,
  newValue: unknown,
): Promise<number> {
  const db = getWebDb();

  const [result] = await db
    .update(themePackages)
    .set({
      definition: sql`JSON_SET(definition, ${jsonPath}, ${JSON.stringify(newValue)})`,
      revision: sql`revision + 1`,
    })
    .where(sql`id = ${id} AND JSON_EXTRACT(definition, ${jsonPath}) = ${JSON.stringify(oldValue)}`);

  return result?.affectedRows ?? 0;
}
