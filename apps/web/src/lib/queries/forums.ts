import { and, asc, count, eq } from "drizzle-orm";
import { forums, getWebDb, threads } from "@funwind/db";

/** 版块查询：目录树 / 单版块 / 真实主题计数（剔除 spam，不信旧统计列） */

export interface ForumRow {
  id: number;
  parentId: number;
  type: "category" | "forum" | "sub" | "sub2";
  name: string;
  nameStyle: string;
  description: string | null;
  vieworder: number;
}

export interface ForumWithSubs {
  forum: ForumRow;
  subs: ForumRow[];
}

export interface ForumCategory {
  category: ForumRow;
  forums: ForumWithSubs[];
}

export async function getAllForums(): Promise<ForumRow[]> {
  const db = getWebDb();
  const rows = await db
    .select({
      id: forums.id,
      parentId: forums.parentId,
      type: forums.type,
      name: forums.name,
      nameStyle: forums.nameStyle,
      description: forums.description,
      vieworder: forums.vieworder,
    })
    .from(forums)
    .where(eq(forums.isShow, true))
    .orderBy(asc(forums.vieworder), asc(forums.id));
  return rows.map((r) => ({ ...r, type: r.type as ForumRow["type"] }));
}

/** 分类 → 版块（含子版块）树；排序沿用旧站 vieworder */
export function buildForumTree(rows: ForumRow[]): ForumCategory[] {
  const categories = rows.filter((r) => r.type === "category");
  const forumsOf = new Map<number, ForumRow[]>();
  for (const r of rows) {
    if (r.type !== "category") {
      const list = forumsOf.get(r.parentId) ?? [];
      list.push(r);
      forumsOf.set(r.parentId, list);
    }
  }
  return categories.map((category) => ({
    category,
    forums: (forumsOf.get(category.id) ?? []).map((forum) => ({
      forum,
      subs: forumsOf.get(forum.id) ?? [],
    })),
  }));
}

export async function getForum(id: number): Promise<ForumRow | null> {
  const db = getWebDb();
  const rows = await db
    .select({
      id: forums.id,
      parentId: forums.parentId,
      type: forums.type,
      name: forums.name,
      nameStyle: forums.nameStyle,
      description: forums.description,
      vieworder: forums.vieworder,
    })
    .from(forums)
    .where(eq(forums.id, id))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, type: row.type as ForumRow["type"] } : null;
}

/** 各版块可见主题数（is_spam=0 且 status=0），供目录展示 */
export async function getForumThreadCounts(): Promise<Map<number, number>> {
  const db = getWebDb();
  const rows = await db
    .select({ fid: threads.forumId, n: count() })
    .from(threads)
    .where(and(eq(threads.isSpam, false), eq(threads.status, 0)))
    .groupBy(threads.forumId);
  return new Map(rows.map((r) => [Number(r.fid), Number(r.n)]));
}
