import "server-only";

import { desc, sql, type SQL } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { getWebDb } from "@funwind/db";

/**
 * 列表查询的共享 SQL 小件（M17 Step 5 提取，消除 log-query / admin/logs / rum 三处重复）。
 * 只放真正同构的片段；各列表的筛选条件组装仍留在各自查询层。
 */

/** LIKE 通配符转义（% _ \），避免用户输入被当通配符 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 统一 COUNT(*)，返回总数；各列表分页共用，避免重复拼 select/count */
export async function countRows(table: MySqlTable, where?: SQL): Promise<number> {
  const [{ n }] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(table)
    .where(where);
  return Number(n);
}

/** 统一「按 id 倒序取一页」；各列表分页共用（调用方自行断言行类型） */
export async function pageItems(
  table: MySqlTable,
  where: SQL | undefined,
  limit: number,
  offset: number,
): Promise<unknown[]> {
  return getWebDb()
    .select()
    .from(table)
    .where(where)
    .orderBy(desc(sql`id`))
    .limit(limit)
    .offset(offset);
}
