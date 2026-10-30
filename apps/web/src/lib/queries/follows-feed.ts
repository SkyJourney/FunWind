import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { follows, getWebDb, posts, threads, users } from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import { THREADS_PER_PAGE, selectList, threadCols, toItem, type HomeFeedItem } from "./threads";
import { extractFeedMedia } from "./feed-media";
import { clampPage } from "./paging";
import { buildViewerScope, visiblePredicate } from "./visibility";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import { publicUserDeleted } from "./public-identity";

/**
 * 关注动态（M8）：关注的版块新帖 + 关注用户的发帖，实时从新表推导（旧 fresh 流不迁）。
 * 可见性与目录口径与首页最新一致：visible 谓词 + is_listed 版块。
 */

export async function followedThreadIds(
  userId: number,
): Promise<{ forumIds: number[]; userIds: number[] }> {
  const db = getWebDb();
  const [forums, activeUsers] = await Promise.all([
    db
      .select({ targetId: follows.targetId })
      .from(follows)
      .where(and(eq(follows.userId, userId), eq(follows.targetType, "forum"))),
    db
      .select({ targetId: follows.targetId })
      .from(follows)
      .innerJoin(users, eq(users.id, follows.targetId))
      .where(
        and(
          eq(follows.userId, userId),
          eq(follows.targetType, "user"),
          eq(users.state, "active"),
          sql`NOT ${publicUserDeleted(users.id, users.state)}`,
        ),
      ),
  ]);
  return {
    forumIds: forums.map((row) => row.targetId),
    userIds: activeUsers.map((row) => row.targetId),
  };
}

export interface FollowFeedPage {
  items: HomeFeedItem[];
  total: number;
  page: number;
  totalPages: number;
  /** 关注的版块数 / 用户数（空态文案用） */
  forumCount: number;
  userCount: number;
}

export type FollowFeedType = "all" | "forum" | "user";

export async function getFollowFeed(
  viewer: Subject,
  rawPage: number,
  type: FollowFeedType = "all",
): Promise<FollowFeedPage> {
  if (viewer.userId === null) {
    return { items: [], total: 0, page: 1, totalPages: 1, forumCount: 0, userCount: 0 };
  }
  const { forumIds, userIds } = await followedThreadIds(viewer.userId);
  const [scope, { tree }] = await Promise.all([buildViewerScope(viewer), getAuthzSnapshot()]);
  const listed = scope.readable.filter((id) => tree.get(id)?.isListed);
  const visibleForumIds = forumIds.filter((id) => listed.includes(id));

  const empty = {
    items: [] as HomeFeedItem[],
    total: 0,
    page: 1,
    totalPages: 1,
    forumCount: visibleForumIds.length,
    userCount: userIds.length,
  };
  // 类型筛选（M10.6d，线稿①）：forum = 仅关注且当前可读版块的新帖；user = 仅关注用户的发帖
  const matchForumIds = type === "user" ? [] : visibleForumIds;
  const matchUserIds = type === "forum" ? [] : userIds;
  if (matchForumIds.length === 0 && matchUserIds.length === 0) return empty;

  // 关注的版块必须可读且上目录；关注用户的帖子必须出自可读版块（scope 兜底不可见性）
  const forumMatch = matchForumIds.length > 0 ? inArray(threads.forumId, matchForumIds) : undefined;
  const userMatch = matchUserIds.length > 0 ? inArray(threads.authorId, matchUserIds) : undefined;
  const listedFilter = listed.length > 0 ? inArray(threads.forumId, listed) : undefined;
  if (listedFilter === undefined) return empty;

  const where = and(visiblePredicate(threadCols, scope), listedFilter, or(forumMatch, userMatch))!;

  const [nRow] = await getWebDb().select({ n: count() }).from(threads).where(where);
  const total = Number(nRow?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const page = clampPage(rawPage, totalPages);

  const rows =
    total === 0
      ? []
      : await selectList(where)
          .orderBy(desc(threads.lastPostedAt), desc(threads.id))
          .limit(THREADS_PER_PAGE)
          .offset((page - 1) * THREADS_PER_PAGE);

  const items = rows.map((r) => toItem(r));

  // 卡片化（M10.6d 站长反馈：与首页 FeedCard 同构）：补封面/摘要
  const media = new Map<number, { coverUrl: string | null; excerpt: string | null }>();
  if (items.length > 0) {
    // 与首页同码：from(threads) innerJoin(posts.floor=1)，可见性谓词才同时引用得到两表
    const bodies = await getWebDb()
      .select({ tid: threads.id, bodyMd: posts.bodyMd })
      .from(threads)
      .innerJoin(posts, and(eq(posts.threadId, threads.id), eq(posts.floor, 1)))
      .where(
        and(
          inArray(
            threads.id,
            items.map((i) => i.id),
          ),
          visiblePredicate(
            { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
            scope,
          ),
        ),
      );
    for (const b of bodies) media.set(b.tid, extractFeedMedia(b.bodyMd));
  }

  return {
    items: items.map((i) => ({ ...i, ...(media.get(i.id) ?? { coverUrl: null, excerpt: null }) })),
    total,
    page,
    totalPages,
    forumCount: visibleForumIds.length,
    userCount: userIds.length,
  };
}
