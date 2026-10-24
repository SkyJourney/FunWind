import { and, asc, count, eq, gt, inArray } from "drizzle-orm";
import { attachments, files, getWebDb, posts, threads, users } from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import type { ThreadListItem } from "./threads";
import { buildViewerScope, visiblePredicate } from "./visibility";

/** 回帖楼层查询：分页（20/页）+ 作者 join + 父帖楼层 + 按帖批量取附件 */

export const REPLIES_PER_PAGE = 20;

export interface ReplyItem {
  id: number;
  floor: number;
  authorId: number;
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

/** 某楼层所在的回帖页码（回帖楼层从 2 起，每页 REPLIES_PER_PAGE 条） */
export const pageOfFloor = (floor: number): number =>
  Math.max(1, Math.ceil((floor - 1) / REPLIES_PER_PAGE));

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
  const safePage = Math.min(Math.max(1, page), totalPages);

  const rows = await db
    .select({
      id: posts.id,
      floor: posts.floor,
      authorId: posts.authorId,
      authorName: users.username,
      authorState: users.state,
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

  const items: ReplyItem[] = rows.map(({ authorState, bodyMd, ...r }) => ({
    ...r,
    bodyMd: bodyMd ?? "",
    authorDeleted: authorState === "deleted",
  }));
  return { items, total, page: safePage, totalPages };
}

/** 回复指针指向的帖子楼层（父帖可能在别的页，所以单独批量取）；同主题限定防止越权探测别的主题 */
export async function getParentFloors(
  threadId: number,
  ids: readonly number[],
): Promise<Map<number, number>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await getWebDb()
    .select({ id: posts.id, floor: posts.floor })
    .from(posts)
    .where(and(eq(posts.threadId, threadId), inArray(posts.id, unique)));
  return new Map(rows.map((r) => [r.id, r.floor]));
}

export interface AttachmentItem {
  id: number;
  postId: number;
  originalName: string;
  downloads: number;
  storageKey: string;
  mime: string;
  sizeBytes: number;
}

/** 按帖批量取附件（一页的全部帖子一次查询，无 N+1）；调用方须只传入已通过可见性校验的帖子 id */
export async function getAttachments(
  postIds: readonly number[],
): Promise<Map<number, AttachmentItem[]>> {
  const out = new Map<number, AttachmentItem[]>();
  if (postIds.length === 0) return out;
  const rows = await getWebDb()
    .select({
      id: attachments.id,
      postId: attachments.postId,
      originalName: attachments.originalName,
      downloads: attachments.downloads,
      storageKey: files.storageKey,
      mime: files.mime,
      sizeBytes: files.sizeBytes,
    })
    .from(attachments)
    .innerJoin(files, eq(files.id, attachments.fileId))
    .where(inArray(attachments.postId, [...postIds]))
    .orderBy(asc(attachments.id));
  for (const r of rows) {
    const list = out.get(r.postId) ?? [];
    list.push(r);
    out.set(r.postId, list);
  }
  return out;
}
