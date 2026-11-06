import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { themePackages } from "./schema.js";
import { affectedRowsOf } from "./sql-result.js";
import { BUILTIN_THEME_PACK_SEEDS } from "./theme-pack-seeds.js";

/** 原语只需要 UPDATE：连接本身和事务句柄都满足（事务句柄没有 `$client`，不能要求完整的 `Db`） */
export type UpgradeExecutor = Pick<Db, "update">;

/**
 * 内置主题包升级原语（M11.6 Step 2，docs/milestones/M11.6-theme-semantic-tokens.md §3.4）。
 *
 * 种子只按主键补缺：已存在的行不会得到后来追加的顶层段，站长编辑过的内容也不应被升级覆盖。
 * 这里提供三个原语，各自一条 UPDATE，同条语句内 revision + 1（G-20：已打开的编辑页下次提交能感知并发）：
 *  · backfillMissingSections：顶层段缺失才补，永不覆盖已有段；
 *  · swapIfUnchanged：路径上的值仍等于旧值才替换，站长改过的跳过；
 *  · resetToBuiltin：整份定义恢复为种子（站长主动采纳升级时用）。
 *
 * 所有值与 JSON 路径都走绑定参数；路径由校验过的段名拼出，不接受自由格式的路径字符串。
 * 返回受影响行数（0 表示没有变化）。审计、目录缓存失效与权限判定由调用方负责。
 */

/** 顶层段名：字母开头的字母数字（tokens、pwa、surfaces 等） */
const SECTION_RE = /^[A-Za-z][A-Za-z0-9]*$/;
/** JSON 路径段：字母数字、下划线、连字符（如 card-foreground）；不含引号与点，拼路径时无需转义 */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** 序列化为 JSON 文本；undefined、函数等无法序列化的值直接报错，避免静默写成 NULL */
function jsonOf(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("值无法序列化为 JSON");
  return text;
}

/** 段名数组 → MySQL JSON 路径（每段加双引号：`$."tokens"."light"`） */
function jsonPathOf(segments: readonly string[]): string {
  if (segments.length === 0) throw new TypeError("JSON 路径不能为空");
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      throw new TypeError(`非法的 JSON 路径段：${JSON.stringify(segment)}`);
    }
  }
  return `$${segments.map((segment) => `."${segment}"`).join("")}`;
}

/**
 * 补齐顶层段：只在缺失时插入（JSON_INSERT 语义），已有段不动；多个段里只要有一个缺失就更新，
 * 且只插入缺失的那些。幂等：全部段都已存在时不写库，revision 不变。
 */
export async function backfillMissingSections(
  db: UpgradeExecutor,
  id: string,
  sections: Readonly<Record<string, unknown>>,
): Promise<number> {
  const entries = Object.entries(sections);
  if (entries.length === 0) return 0;
  for (const [name] of entries) {
    if (!SECTION_RE.test(name)) throw new TypeError(`非法的顶层段名：${JSON.stringify(name)}`);
  }
  const paths = entries.map(([name]) => jsonPathOf([name]));
  const inserts = entries.flatMap(([, value], index) => [
    sql`${paths[index]}`,
    sql`CAST(${jsonOf(value)} AS JSON)`,
  ]);
  const missing = paths.map(
    (path) => sql`NOT JSON_CONTAINS_PATH(${themePackages.definition}, 'one', ${path})`,
  );
  const result = await db
    .update(themePackages)
    .set({
      definition: sql`JSON_INSERT(${themePackages.definition}, ${sql.join(inserts, sql`, `)})`,
      revision: sql`${themePackages.revision} + 1`,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(themePackages.id, id), or(...missing)));
  return affectedRowsOf(result);
}

/**
 * 有条件替换：`path` 上的值仍等于 `oldValue`（按 JSON 语义比较）才替换为 `newValue`。
 * 路径不存在或值已被站长改过时不写库，返回 0。
 */
export async function swapIfUnchanged(
  db: UpgradeExecutor,
  id: string,
  path: readonly string[],
  oldValue: unknown,
  newValue: unknown,
): Promise<number> {
  const jsonPath = jsonPathOf(path);
  const result = await db
    .update(themePackages)
    .set({
      definition: sql`JSON_REPLACE(${themePackages.definition}, ${jsonPath}, CAST(${jsonOf(newValue)} AS JSON))`,
      revision: sql`${themePackages.revision} + 1`,
      updatedAt: sql`NOW()`,
    })
    .where(
      and(
        eq(themePackages.id, id),
        sql`JSON_EXTRACT(${themePackages.definition}, ${jsonPath}) = CAST(${jsonOf(oldValue)} AS JSON)`,
      ),
    );
  return affectedRowsOf(result);
}

/** 一条有条件的替换：`path` 上的值仍等于 `from` 才换成 `to` */
export interface PathSwap {
  path: readonly string[];
  from: unknown;
  to: unknown;
}

/**
 * 批量有条件替换：一条 UPDATE 处理多条路径，每条路径各自判断「仍等于旧值才替换」，
 * 任意一条命中才写库，`revision` 只 +1（逐条调用 swapIfUnchanged 会让 revision 每条 +1，
 * 一次升级改 8 条路径就从 2 跳到 10，破坏「版本号 = 保存次数」的语义）。
 * 语义与 swapIfUnchanged 一致：路径不存在不创建（JSON_REPLACE 对缺失路径无动作），站长改过的值不动。
 * 全部不命中（缺失、已是新值、被改过）时不写库，返回 0；幂等。
 */
export async function swapManyIfUnchanged(
  db: UpgradeExecutor,
  id: string,
  swaps: readonly PathSwap[],
): Promise<number> {
  if (swaps.length === 0) return 0;
  const parts = swaps.map((swap) => {
    const jsonPath = jsonPathOf(swap.path);
    const current = sql`JSON_EXTRACT(${themePackages.definition}, ${jsonPath})`;
    const matches = sql`${current} = CAST(${jsonOf(swap.from)} AS JSON)`;
    return { jsonPath, matches, current, to: jsonOf(swap.to) };
  });
  // JSON_REPLACE(doc, path1, v1, path2, v2, ...)：每个新值是 IF(命中, 新值, 原值)
  const replaceArgs = parts.flatMap((part) => [
    sql`${part.jsonPath}`,
    sql`IF(${part.matches}, CAST(${part.to} AS JSON), ${part.current})`,
  ]);
  const result = await db
    .update(themePackages)
    .set({
      definition: sql`JSON_REPLACE(${themePackages.definition}, ${sql.join(replaceArgs, sql`, `)})`,
      revision: sql`${themePackages.revision} + 1`,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(themePackages.id, id), or(...parts.map((part) => part.matches))));
  return affectedRowsOf(result);
}

/**
 * 重置为内置定义：把整份 definition 恢复为种子里的版本。只作用于 `is_builtin = 1` 的种子包，
 * 不是内置种子的 id 返回 0。名称、说明、启停状态与素材清单不动。
 */
export async function resetToBuiltin(db: UpgradeExecutor, id: string): Promise<number> {
  const seed = BUILTIN_THEME_PACK_SEEDS.find((candidate) => candidate.id === id);
  if (!seed) return 0;
  const result = await db
    .update(themePackages)
    .set({
      definition: sql`CAST(${jsonOf(seed.definition)} AS JSON)`,
      revision: sql`${themePackages.revision} + 1`,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(themePackages.id, id), eq(themePackages.isBuiltin, true)));
  return affectedRowsOf(result);
}
