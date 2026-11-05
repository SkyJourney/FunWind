import "server-only";
import { sql } from "drizzle-orm";
import { getWebDb } from "@funwind/db";

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

  // 构造 JSON_INSERT 表达式：对每个段，只在路径不存在时插入
  const paths: string[] = [];
  const values: string[] = [];
  for (const [key, value] of Object.entries(sections)) {
    paths.push(`'$.${key}'`);
    values.push(`CAST('${JSON.stringify(value).replace(/'/g, "''")}' AS JSON)`);
  }

  // 只在至少一个段缺失时才更新
  const missingChecks = Object.keys(sections)
    .map((key) => `JSON_CONTAINS_PATH(definition, 'one', '$.${key}') = 0`)
    .join(" OR ");

  const [result] = await db.execute(
    sql.raw(
      `UPDATE theme_packages SET definition = JSON_INSERT(definition, ${paths.map((p, i) => `${p}, ${values[i]}`).join(", ")}), revision = revision + 1 WHERE id = '${id}' AND (${missingChecks})`,
    ),
  );

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

  const [result] = await db.execute(
    sql.raw(
      `UPDATE theme_packages SET definition = JSON_REPLACE(definition, '${jsonPath}', CAST('${JSON.stringify(newValue).replace(/'/g, "''")}' AS JSON)), revision = revision + 1 WHERE id = '${id}' AND JSON_EXTRACT(definition, '${jsonPath}') = CAST('${JSON.stringify(oldValue).replace(/'/g, "''")}' AS JSON)`,
    ),
  );

  return result?.affectedRows ?? 0;
}
