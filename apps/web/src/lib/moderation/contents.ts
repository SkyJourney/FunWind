import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { forums, getWebDb, posts, threads, users } from "@funwind/db";

/**
 * 内容管理查询（M9.5 §9.2-A）：后台跨主题/回帖的**定位**能力——
 * 标题/正文关键词 + 板块 + 六态筛选 + 分页，服务层按版主作用域过滤（admin.recycle 持全站视角）。
 * 主题与回帖共用一套状态机与操作，行内动作按 kind 分派。
 */

export type ContentKind = "thread" | "reply";
export type ContentStateFilter =
  "all" | "visible" | "pending" | "rejected" | "hidden" | "deleted" | "disabled";

export type ContentListFilters = {
  kind: ContentKind;
  q?: string;
  forumId?: number;
  state: ContentStateFilter;
  page: number;
  perPage?: number;
  /** 版主所辖版块（空数组 = 无权限）；null = 全站视角（admin.recycle / site.admin） */
  scopeForumIds: number[] | null;
};

export interface ContentListItem {
  postId: number;
  threadId: number;
  forumId: number;
  forumName: string;
  title: string;
  /** 回帖才有：正文前 80 字 */
  excerpt: string | null;
  authorId: number;
  authorName: string | null;
  /** 作者是否被封禁（M9.5 §9.2-E：后台队列加徽标，公开页维持无标记） */
  authorBanned: boolean;
  state: string;
  isThread: boolean;
  createdAt: string;
  replyCount: number | null;
  isLocked: boolean | null;
  isFeatured: boolean | null;
  pinLevel: number | null;
}

/** 内容管理列表（分页 + 定位筛选） */
export async function listContentsPage(
  filters: ContentListFilters,
): Promise<{ items: ContentListItem[]; total: number }> {
  const perPage = filters.perPage ?? 20;
  const conds = [];

  // 主题：threads.state；回帖：posts.state
  const stateCol = filters.kind === "thread" ? threads.state : posts.state;
  if (filters.state !== "all") conds.push(eq(stateCol, filters.state as never));
  if (filters.forumId) conds.push(eq(threads.forumId, filters.forumId));
  if (filters.scopeForumIds) {
    if (filters.scopeForumIds.length === 0) return { items: [], total: 0 };
    conds.push(inArray(threads.forumId, filters.scopeForumIds));
  }
  const q = filters.q?.trim();
  if (q) {
    // 主题按标题搜；回帖按正文搜（作者名也搜，便于按人定位）
    conds.push(
      filters.kind === "thread"
        ? sql`${threads.title} LIKE ${`%${q}%`}`
        : sql`(${posts.bodyMd} LIKE ${`%${q}%`} OR ${threads.title} LIKE ${`%${q}%`})`,
    );
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  // 主查询：主题走 threads join posts(首帖)；回帖走 posts join threads
  const base = getWebDb();
  const listSelect =
    filters.kind === "thread"
      ? {
          postId: sql<number>`threads.first_post_id`,
          threadId: threads.id,
          forumId: threads.forumId,
          forumName: forums.name,
          title: threads.title,
          excerpt: sql<string | null>`NULL`,
          authorId: threads.authorId,
          authorName: users.username,
          authorBanned:
            sql<boolean>`EXISTS (SELECT 1 FROM user_restrictions ur WHERE ur.user_id = ${threads.authorId}
              AND ur.kind = 'ban' AND ur.scope_id = 0 AND ur.starts_at <= NOW()
              AND (ur.ends_at IS NULL OR ur.ends_at > NOW()))`.mapWith(Boolean),
          state: threads.state,
          isThread: sql<boolean>`TRUE`.mapWith(Boolean),
          createdAt: threads.createdAt,
          replyCount: threads.replyCount,
          isLocked: threads.isLocked,
          isFeatured: threads.isFeatured,
          pinLevel: threads.pinLevel,
        }
      : {
          postId: posts.id,
          threadId: threads.id,
          forumId: threads.forumId,
          forumName: forums.name,
          title: threads.title,
          excerpt: sql<string | null>`SUBSTRING(${posts.bodyMd}, 1, 80)`,
          authorId: posts.authorId,
          authorName: users.username,
          authorBanned:
            sql<boolean>`EXISTS (SELECT 1 FROM user_restrictions ur WHERE ur.user_id = ${posts.authorId}
              AND ur.kind = 'ban' AND ur.scope_id = 0 AND ur.starts_at <= NOW()
              AND (ur.ends_at IS NULL OR ur.ends_at > NOW()))`.mapWith(Boolean),
          state: posts.state,
          isThread: sql<boolean>`FALSE`.mapWith(Boolean),
          createdAt: posts.createdAt,
          replyCount: sql<number | null>`NULL`,
          isLocked: sql<boolean | null>`NULL`,
          isFeatured: sql<boolean | null>`NULL`,
          pinLevel: sql<number | null>`NULL`,
        };

  const rowsPromise = base
    .select(listSelect)
    .from(filters.kind === "thread" ? threads : posts)
    .innerJoin(threads, eq(threads.id, filters.kind === "thread" ? threads.id : posts.threadId))
    .innerJoin(forums, eq(forums.id, threads.forumId))
    .leftJoin(users, eq(users.id, filters.kind === "thread" ? threads.authorId : posts.authorId))
    .where(where)
    .orderBy(desc(filters.kind === "thread" ? threads.createdAt : posts.createdAt))
    .limit(perPage)
    .offset((filters.page - 1) * perPage);

  const countPromise = base
    .select({ total: sql<number>`COUNT(*)` })
    .from(filters.kind === "thread" ? threads : posts)
    .innerJoin(threads, eq(threads.id, filters.kind === "thread" ? threads.id : posts.threadId))
    .where(where);

  const [rows, countRow] = await Promise.all([rowsPromise, countPromise]);
  return { items: rows, total: Number(countRow[0]?.total ?? 0) };
}

/**
 * 主题级设置（锁定 / 置顶 / 精华）——M9.5 §9.2-C 补写入口。
 * 权限：版主可设所辖版块的主题；置顶级别版主最高 1（版块级），site.admin 可设到 3（全站）。
 */
export type ThreadFlagsResult =
  { ok: true } | { ok: false; code: "not_found" | "forbidden" | "bad_pin"; message: string };

export async function setThreadFlags(
  operator: { userId: number | null },
  threadId: number,
  flags: { locked?: boolean; featured?: boolean; pinLevel?: number },
  actor: { userId: number; via: "admin"; ip: string | null },
): Promise<ThreadFlagsResult> {
  if (operator.userId === null) return { ok: false, code: "forbidden", message: "请先登录" };
  const db = getWebDb();
  const [row] = await db
    .select({ forumId: threads.forumId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  if (!row) return { ok: false, code: "not_found", message: "主题不存在" };

  const { checkPermission } = await import("@/lib/authz/service");
  const isSiteAdmin = (await checkPermission(operator as never, "site.admin")).allowed;
  if (!isSiteAdmin) {
    const allowed = (
      await checkPermission(operator as never, "forum.moderate", { forumId: row.forumId })
    ).allowed;
    if (!allowed) return { ok: false, code: "forbidden", message: "你不是该版块的版主" };
  }
  // 版主置顶上限 1（版块级）；全站置顶仅 site.admin
  const maxPin = isSiteAdmin ? 3 : 1;
  if (flags.pinLevel !== undefined && flags.pinLevel > maxPin) {
    return { ok: false, code: "bad_pin", message: `置顶级别超出权限（最高 ${maxPin}）` };
  }

  const patch: Record<string, unknown> = {};
  if (flags.locked !== undefined) patch.isLocked = flags.locked;
  if (flags.featured !== undefined) patch.isFeatured = flags.featured;
  if (flags.pinLevel !== undefined) patch.pinLevel = flags.pinLevel;
  if (Object.keys(patch).length === 0) return { ok: false, code: "not_found", message: "没有变更" };

  const { writeAudit } = await import("@/lib/audit");
  await db.transaction(async (tx) => {
    await tx.update(threads).set(patch).where(eq(threads.id, threadId));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "admin.thread.flags",
      targetType: "thread",
      targetId: threadId,
      after: { ...patch, via: actor.via },
      ip: actor.ip,
    });
  });
  return { ok: true };
}
