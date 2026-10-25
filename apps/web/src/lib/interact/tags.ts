import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getWebDb, tags, threadTags, threads } from "@funwind/db";
import type { DbTx } from "@/lib/audit";

/**
 * 主题标签（M8）：thread_tags 写路径只维护关联行；`tags.thread_count` 缓存列**不做写路径同步**
 * （recount 口径只数 visible 主题，写路径同步要与状态迁移联动、复杂且易漂移——
 * 读侧（标签云/筛选）实时聚合，缓存列仅由 recount/db:verify 对账使用。取舍记录于 M8 文档）。
 * 新标签的创建需要 `tag.add` 权限（member 基线已授予）；挂已有标签只需 forum.write。
 */

export const MAX_TAGS_PER_THREAD = 5;

export type ResolveTagsResult =
  { ok: true; tagIds: number[] } | { ok: false; code: "tag_too_many" | "tag_denied" };

/** 解析标签名（去重/裁剪/长度过滤）；缺失标签在 canAdd 时创建、否则拒绝 */
export async function resolveTagIds(
  tx: DbTx,
  names: readonly string[],
  canAdd: boolean,
): Promise<ResolveTagsResult> {
  const cleaned = [
    ...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0 && n.length <= 32)),
  ];
  if (cleaned.length === 0) return { ok: true, tagIds: [] };
  if (cleaned.length > MAX_TAGS_PER_THREAD) return { ok: false, code: "tag_too_many" };

  const existing = await tx
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(inArray(tags.name, cleaned));
  const byName = new Map(existing.map((t) => [t.name, t.id]));

  const ids: number[] = [];
  for (const name of cleaned) {
    const known = byName.get(name);
    if (known !== undefined) {
      ids.push(known);
      continue;
    }
    if (!canAdd) return { ok: false, code: "tag_denied" };
    // 并发同名新建：upsert 后按名回查拿真实行 id（insertId 在更新路径不可靠）
    await tx
      .insert(tags)
      .values({ name, threadCount: 0 })
      .onDuplicateKeyUpdate({ set: { name: sql`${tags.name}` } });
    const [row] = await tx.select({ id: tags.id }).from(tags).where(eq(tags.name, name)).limit(1);
    if (row) ids.push(row.id);
  }
  return { ok: true, tagIds: ids };
}

/** 替换某主题的全部标签（发帖/编辑共用；空数组 = 清空） */
export async function replaceThreadTags(
  tx: DbTx,
  threadId: number,
  tagIds: readonly number[],
): Promise<void> {
  await tx.delete(threadTags).where(eq(threadTags.threadId, threadId));
  if (tagIds.length > 0) {
    await tx
      .insert(threadTags)
      .values([...new Set(tagIds)].map((tagId) => ({ threadId, tagId })))
      .onDuplicateKeyUpdate({ set: { threadId: sql`${threadTags.threadId}` } });
  }
}

export interface ThreadTagView {
  id: number;
  name: string;
}

/** 一批主题各自的标签（帖子页/列表用；一次查询） */
export async function tagsOfThreads(
  threadIds: readonly number[],
): Promise<Map<number, ThreadTagView[]>> {
  if (threadIds.length === 0) return new Map();
  const rows = await getWebDb()
    .select({ threadId: threadTags.threadId, id: tags.id, name: tags.name })
    .from(threadTags)
    .innerJoin(tags, eq(tags.id, threadTags.tagId))
    .where(inArray(threadTags.threadId, [...threadIds]))
    .orderBy(tags.name);
  const out = new Map<number, ThreadTagView[]>();
  for (const r of rows) {
    const list = out.get(r.threadId) ?? [];
    list.push({ id: r.id, name: r.name });
    out.set(r.threadId, list);
  }
  return out;
}

export interface TagCount {
  id: number;
  name: string;
  count: number;
}

/** 版块内标签云（实时聚合，不走 thread_count 缓存列；按主题数降序） */
export async function forumTagCloud(forumId: number, limit = 10): Promise<TagCount[]> {
  return getWebDb()
    .select({
      id: tags.id,
      name: tags.name,
      count: sql<number>`COUNT(*)`,
    })
    .from(threadTags)
    .innerJoin(tags, eq(tags.id, threadTags.tagId))
    .innerJoin(
      threads,
      and(
        eq(threads.id, threadTags.threadId),
        eq(threads.forumId, forumId),
        eq(threads.state, "visible"),
      ),
    )
    .groupBy(tags.id, tags.name)
    .orderBy(desc(sql`COUNT(*)`), tags.name)
    .limit(limit);
}

/** 按标签名解析标签（版块筛选 ?tag= 用；不存在返回 null） */
export async function tagByName(name: string): Promise<{ id: number; name: string } | null> {
  const [row] = await getWebDb()
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.name, name))
    .limit(1);
  return row ?? null;
}
