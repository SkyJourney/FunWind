import { and, asc, count, eq, gt } from "drizzle-orm";
import { getWebDb, posts, threads, users } from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import type { ThreadListItem } from "./threads";
import { clampPage } from "./paging";
import { buildViewerScope, visiblePredicate } from "./visibility";
import { publicUserDeleted, publicUserId, publicUsername } from "./public-identity";

/** 回帖楼层查询：分页（20/页）+ 作者 join + 父帖楼层 + 按帖批量取附件 */

export const REPLIES_PER_PAGE = 20;

export interface ReplyItem {
  id: number;
  floor: number;
  authorId: number | null;
  authorName: string | null;
  authorDeleted: boolean;
  bodyMd: string;
  hasGate: boolean;
  likeCount: number;
  replyToPostId: number | null;
  state: ThreadListItem["state"];
  createdAt: string;
  editedAt: string | null;
}

/**
 * 回帖分页。thread 必须是 getThreadView 已按 viewer 校验过的主题；
 * 回帖自身的状态仍按 viewer 过滤（回帖可以被单独屏蔽/删除/待审）。
 */
export async function listReplies(
  viewer: Subject,
  thread: { id: number; forumId: number },
  page: number,
): Promise<{ items: ReplyItem[]; total: number; page: number; totalPages: number }> {
  const scope = await buildViewerScope(viewer);
  const where = and(
    eq(posts.threadId, thread.id),
    gt(posts.floor, 1),
    // 回帖没有 forum_id 列：可见性判定用所属主题的版块
    visiblePredicate(
      { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
      scope,
    ),
  )!;
  const db = getWebDb();

  const [nRow] = await db
    .select({ n: count() })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(where);
  const total = Number(nRow?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / REPLIES_PER_PAGE));
  const safePage = clampPage(page, totalPages);

  const rows = await db
    .select({
      id: posts.id,
      floor: posts.floor,
      authorId: publicUserId(users.id, users.state),
      authorName: publicUsername(users.username, users.state, users.id),
      authorDeleted: publicUserDeleted(users.id, users.state).mapWith(Boolean),
      bodyMd: posts.bodyMd,
      hasGate: posts.hasGate,
      likeCount: posts.likeCount,
      replyToPostId: posts.replyToPostId,
      state: posts.state,
      createdAt: posts.createdAt,
      editedAt: posts.editedAt,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .leftJoin(users, eq(users.id, posts.authorId))
    .where(where)
    .orderBy(asc(posts.floor))
    .limit(REPLIES_PER_PAGE)
    .offset((safePage - 1) * REPLIES_PER_PAGE);

  const items: ReplyItem[] = rows.map(({ bodyMd, ...r }) => ({
    ...r,
    bodyMd: bodyMd ?? "",
  }));
  return { items, total, page: safePage, totalPages };
}
