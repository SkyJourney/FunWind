import { and, asc, count, eq, isNull } from "drizzle-orm";
import { attachments, getWebDb, posts, users } from "@funwind/db";

/** 回帖楼层查询：分页（20/页）+ 作者 join（孤儿→已注销）+ 首帖附件 */

export const FLOORS_PER_PAGE = 20;

export interface FloorItem {
  id: number;
  floor: number;
  authorName: string | null;
  authorId: number;
  contentMd: string | null;
  replyToPid: number | null;
  createdAt: string | null;
}

export async function listFloors(
  tid: number,
  page: number,
): Promise<{ items: FloorItem[]; total: number; totalPages: number }> {
  const db = getWebDb();
  const where = and(eq(posts.threadId, tid), eq(posts.status, 0));
  const [nRows] = await db.select({ n: count() }).from(posts).where(where);
  const total = Number(nRows?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / FLOORS_PER_PAGE));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const items = await db
    .select({
      id: posts.id,
      floor: posts.floor,
      authorName: users.username,
      authorId: posts.authorId,
      contentMd: posts.contentMd,
      replyToPid: posts.replyToPid,
      createdAt: posts.createdAt,
    })
    .from(posts)
    .leftJoin(users, eq(posts.authorId, users.id))
    .where(where)
    .orderBy(asc(posts.floor))
    .limit(FLOORS_PER_PAGE)
    .offset((safePage - 1) * FLOORS_PER_PAGE);

  return { items, total, totalPages };
}

/** 首帖附件（post_id 为空 = 挂在主题上的附件） */
export interface AttachmentItem {
  id: number;
  filename: string;
  type: string;
  path: string;
  downloads: number;
}

export async function getThreadAttachments(tid: number): Promise<AttachmentItem[]> {
  const db = getWebDb();
  return db
    .select({
      id: attachments.id,
      filename: attachments.filename,
      type: attachments.type,
      path: attachments.path,
      downloads: attachments.downloads,
    })
    .from(attachments)
    .where(and(eq(attachments.threadId, tid), isNull(attachments.postId)));
}
