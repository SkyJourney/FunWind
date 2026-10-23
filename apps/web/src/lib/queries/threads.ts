import { and, asc, count, desc, eq } from "drizzle-orm";
import { getWebDb, threads, topicTypes, users } from "@funwind/db";

/** 主题查询：版块列表（置顶前置/分类筛选/分页）、详情、全站最新 */

export const THREADS_PER_PAGE = 25;

export interface ThreadListItem {
  id: number;
  forumId: number;
  title: string;
  authorName: string | null; // null = 孤儿作者（已注销）
  authorId: number;
  replyCount: number;
  viewCount: number;
  digest: number;
  topped: number;
  special: string;
  attachCount: number;
  lastPostAt: string | null;
  typeId: number;
}

const LIST_SELECTION = {
  id: threads.id,
  forumId: threads.forumId,
  title: threads.title,
  authorName: users.username,
  authorId: threads.authorId,
  replyCount: threads.replyCount,
  viewCount: threads.viewCount,
  digest: threads.digest,
  topped: threads.topped,
  special: threads.special,
  attachCount: threads.attachCount,
  lastPostAt: threads.lastPostAt,
  typeId: threads.typeId,
} as const;

function listWhere(fid: number, typeId?: number) {
  const conds = [eq(threads.isSpam, false), eq(threads.status, 0), eq(threads.forumId, fid)];
  if (typeId && typeId > 0) conds.push(eq(threads.typeId, typeId));
  return and(...conds);
}

/** 版块主题列表：置顶组前置（topped desc），其余按最后回帖时间 */
export async function listThreads(
  fid: number,
  opts: { page: number; typeId?: number },
): Promise<{ items: ThreadListItem[]; total: number; page: number; totalPages: number }> {
  const db = getWebDb();
  const where = listWhere(fid, opts.typeId);
  const [nRows] = await db.select({ n: count() }).from(threads).where(where);
  const total = Number(nRows?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const page = Math.min(Math.max(1, opts.page), totalPages);

  const items = await db
    .select(LIST_SELECTION)
    .from(threads)
    .leftJoin(users, eq(threads.authorId, users.id))
    .where(where)
    .orderBy(desc(threads.topped), desc(threads.lastPostAt), desc(threads.id))
    .limit(THREADS_PER_PAGE)
    .offset((page - 1) * THREADS_PER_PAGE);

  return { items, total, page, totalPages };
}

/** 全站最新（首页聚合用） */
export async function getLatestThreads(limit = 10): Promise<ThreadListItem[]> {
  const db = getWebDb();
  return db
    .select(LIST_SELECTION)
    .from(threads)
    .leftJoin(users, eq(threads.authorId, users.id))
    .where(and(eq(threads.isSpam, false), eq(threads.status, 0)))
    .orderBy(desc(threads.lastPostAt), desc(threads.id))
    .limit(limit);
}

export interface ThreadDetail {
  id: number;
  forumId: number;
  title: string;
  authorName: string | null;
  authorId: number;
  replyCount: number;
  viewCount: number;
  digest: number;
  special: string;
  status: number;
  isSpam: boolean;
  contentMd: string | null;
  contentRaw: string | null;
  createdAt: string | null;
  lastPostAt: string | null;
  attachCount: number;
}

/** 帖子详情（含任意状态：spam/屏蔽由调用方决定 404 或 blocked 视图） */
export async function getThreadDetail(tid: number): Promise<ThreadDetail | null> {
  const db = getWebDb();
  const rows = await db
    .select({
      id: threads.id,
      forumId: threads.forumId,
      title: threads.title,
      authorName: users.username,
      authorId: threads.authorId,
      replyCount: threads.replyCount,
      viewCount: threads.viewCount,
      digest: threads.digest,
      special: threads.special,
      status: threads.status,
      isSpam: threads.isSpam,
      contentMd: threads.contentMd,
      contentRaw: threads.contentRaw,
      createdAt: threads.createdAt,
      lastPostAt: threads.lastPostAt,
      attachCount: threads.attachCount,
    })
    .from(threads)
    .leftJoin(users, eq(threads.authorId, users.id))
    .where(eq(threads.id, tid))
    .limit(1);
  return rows[0] ?? null;
}

/** 版块主题分类（forum 页筛选） */
export async function getTopicTypes(fid: number): Promise<{ id: number; name: string }[]> {
  const db = getWebDb();
  return db
    .select({ id: topicTypes.id, name: topicTypes.name })
    .from(topicTypes)
    .where(eq(topicTypes.fid, fid))
    .orderBy(asc(topicTypes.vieworder), asc(topicTypes.id));
}

/** 全站非垃圾帖总数（首页统计） */
export async function getVisibleThreadCount(): Promise<number> {
  const db = getWebDb();
  const [row] = await db
    .select({ n: count() })
    .from(threads)
    .where(and(eq(threads.isSpam, false), eq(threads.status, 0)));
  return Number(row?.n ?? 0);
}
