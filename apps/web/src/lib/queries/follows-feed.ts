import { and, count, desc, eq, inArray, or } from "drizzle-orm";
import { follows, getWebDb, threads } from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import { THREADS_PER_PAGE, selectList, threadCols, toItem, type ThreadListItem } from "./threads";
import { clampPage } from "./paging";
import { buildViewerScope, visiblePredicate } from "./visibility";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";

/**
 * 关注动态（M8）：关注的版块新帖 + 关注用户的发帖，实时从新表推导（旧 fresh 流不迁）。
 * 可见性与目录口径与首页最新一致：visible 谓词 + is_listed 版块。
 */

export async function followedThreadIds(
  userId: number,
): Promise<{ forumIds: number[]; userIds: number[] }> {
  const rows = await getWebDb()
    .select({ targetType: follows.targetType, targetId: follows.targetId })
    .from(follows)
    .where(eq(follows.userId, userId));
  return {
    forumIds: rows.filter((r) => r.targetType === "forum").map((r) => r.targetId),
    userIds: rows.filter((r) => r.targetType === "user").map((r) => r.targetId),
  };
}

export interface FollowFeedPage {
  items: ThreadListItem[];
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

  const empty = {
    items: [] as ThreadListItem[],
    total: 0,
    page: 1,
    totalPages: 1,
    forumCount: forumIds.length,
    userCount: userIds.length,
  };
  // 类型筛选（M10.6d，线稿①）：forum = 仅关注版块的新帖；user = 仅关注用户的发帖
  const matchForumIds = type === "user" ? [] : forumIds;
  const matchUserIds = type === "forum" ? [] : userIds;
  if (matchForumIds.length === 0 && matchUserIds.length === 0) return empty;

  // 关注的版块必须可读且上目录；关注用户的帖子必须出自可读版块（scope 兜底不可见性）
  const forumMatch = matchForumIds.length > 0 ? inArray(threads.forumId, matchForumIds) : undefined;
  const userMatch = matchUserIds.length > 0 ? inArray(threads.authorId, matchUserIds) : undefined;
  const listedFilter = listed.length > 0 ? inArray(threads.forumId, listed) : undefined;
  if (listedFilter === undefined)
    return { ...empty, forumCount: forumIds.length, userCount: userIds.length };

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

  return {
    items: rows.map((r) => toItem(r)),
    total,
    page,
    totalPages,
    forumCount: forumIds.length,
    userCount: userIds.length,
  };
}
