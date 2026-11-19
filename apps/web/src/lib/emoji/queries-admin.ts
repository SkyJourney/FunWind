import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { emojiGroups, emojis, getWebDb } from "@funwind/db";
// ------------------------------------------------------------
// 管理读（含停用全量；公开面板目录只出 enabled，口径不同）
// ------------------------------------------------------------

export type AdminEmojiGroupRow = {
  id: number;
  name: string;
  sort: number;
  iconKey: string | null;
  enabled: boolean;
  emojiCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminEmojiRow = {
  id: number;
  groupId: number;
  groupName: string | null;
  name: string;
  keywords: string;
  ext: string | null;
  sort: number;
  enabled: boolean;
  updatedAt: string;
};

/** 管理视角：全部组（含停用）+ 组内表情计数聚合（leftJoin + groupBy 标准口径）。 */
export async function listEmojiGroupsAdmin(): Promise<AdminEmojiGroupRow[]> {
  const rows = await getWebDb()
    .select({
      id: emojiGroups.id,
      name: emojiGroups.name,
      sort: emojiGroups.sort,
      iconKey: emojiGroups.iconKey,
      enabled: emojiGroups.enabled,
      createdAt: emojiGroups.createdAt,
      updatedAt: emojiGroups.updatedAt,
      emojiCount: sql<number>`COUNT(${emojis.id})`,
    })
    .from(emojiGroups)
    .leftJoin(emojis, eq(emojis.groupId, emojiGroups.id))
    .groupBy(emojiGroups.id)
    .orderBy(asc(emojiGroups.sort), asc(emojiGroups.id));
  return rows.map((row) => ({ ...row, emojiCount: Number(row.emojiCount) }));
}

/** 管理视角：表情分页（含停用；组与名称/keywords 搜索），按 (sort, id) 升序。 */
export async function listEmojisAdminPage(filters: {
  groupId?: number;
  q?: string;
  page: number;
  perPage?: number;
}): Promise<{ items: AdminEmojiRow[]; total: number; page: number; totalPages: number }> {
  const perPage = filters.perPage ?? 50;
  const conds = [];
  if (filters.groupId) conds.push(eq(emojis.groupId, filters.groupId));
  const q = filters.q?.trim();
  if (q) conds.push(sql`(${emojis.name} LIKE ${`%${q}%`} OR ${emojis.keywords} LIKE ${`%${q}%`})`);
  const where = conds.length > 0 ? and(...conds) : undefined;
  const base = getWebDb();
  const [countRow] = await base
    .select({ total: sql<number>`COUNT(*)` })
    .from(emojis)
    .where(where);
  const total = Number(countRow?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, filters.page), totalPages);
  const rows = await base
    .select({
      id: emojis.id,
      groupId: emojis.groupId,
      groupName: emojiGroups.name,
      name: emojis.name,
      keywords: emojis.keywords,
      ext: emojis.ext,
      sort: emojis.sort,
      enabled: emojis.enabled,
      updatedAt: emojis.updatedAt,
    })
    .from(emojis)
    .leftJoin(emojiGroups, eq(emojiGroups.id, emojis.groupId))
    .where(where)
    .orderBy(desc(emojis.enabled), asc(emojis.sort), asc(emojis.id))
    .limit(perPage)
    .offset((page - 1) * perPage);
  return { items: rows, total, page, totalPages };
}
