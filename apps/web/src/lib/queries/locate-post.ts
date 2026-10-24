import { and, count, eq, gt, lte } from "drizzle-orm";
import { getWebDb, posts, threads } from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import { REPLIES_PER_PAGE } from "./posts";
import { buildViewerScope, visiblePredicate } from "./visibility";

/**
 * 定位一条回帖所在的页码（M6.1 第 6 步，设计稿 §7.3）。
 *
 * 旧的楼层分页函数假定楼层连续，但分页是按**观众可见的回帖**偏移的：一旦中间有隐藏、待审、已删除的帖子，
 * 楼层号算出来的页码就错了（而且不同观众看到的页码不同）。这里统计的是"楼层 ≤ 目标、且对这位观众可见的回帖数"，
 * 它就是目标在观众视角的序号，再按每页条数换算页码——与 listReplies 的 offset 口径一致。
 */

/** 可见回帖序号（从 1 起）所在的页码；首帖不占页，所以序号从回帖算起 */
export const pageForReplyIndex = (index: number): number =>
  Math.max(1, Math.ceil(index / REPLIES_PER_PAGE));

export interface PostLocation {
  postId: number;
  threadId: number;
  floor: number;
  /** 观众视角下的页码；首帖在每一页都显示，记为第 1 页 */
  page: number;
}

/**
 * 帖子在主题页里的地址。第一页不写 page 参数（与 /t/{tid} 的默认一致）；锚点保持 #p{pid}。
 * URL 形态已冻结（硬约定 8：/t/{tid}、?page=、#p{pid}），这里只是把它们拼起来。
 */
export function postPath(loc: Pick<PostLocation, "threadId" | "postId" | "page">): string {
  const q = loc.page > 1 ? `?page=${loc.page}` : "";
  return `/t/${loc.threadId}${q}#p${loc.postId}`;
}

/**
 * 对观众可见的帖子定位。帖子或所在主题对观众不可见（版块不可读、状态不可见、已删除）返回 null，
 * 调用方一律当作不存在处理（硬约定 7：越权表现为 404）。
 */
export async function locatePost(viewer: Subject, postId: number): Promise<PostLocation | null> {
  const scope = await buildViewerScope(viewer);
  const db = getWebDb();
  const [target] = await db
    .select({
      postId: posts.id,
      threadId: posts.threadId,
      floor: posts.floor,
      forumId: threads.forumId,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(
      and(
        eq(posts.id, postId),
        visiblePredicate(
          { forumId: threads.forumId, state: threads.state, authorId: threads.authorId },
          scope,
        ),
        visiblePredicate(
          { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
          scope,
        ),
      ),
    )
    .limit(1);
  if (!target) return null;

  const base = { postId: target.postId, threadId: target.threadId, floor: target.floor };
  if (target.floor === 1) return { ...base, page: 1 };

  // 楼层 ≤ 目标、且对观众可见的回帖数（含目标自身，因为目标已确认可见）
  const [n] = await db
    .select({ n: count() })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(
      and(
        eq(posts.threadId, target.threadId),
        gt(posts.floor, 1),
        lte(posts.floor, target.floor),
        visiblePredicate(
          { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
          scope,
        ),
      ),
    );
  return { ...base, page: pageForReplyIndex(Number(n?.n ?? 1)) };
}

/**
 * 批量定位同一页上的父帖（回复引用）。不可见的父帖映射为 null，页面上不渲染链接，也不泄露它的楼层。
 * 每页最多 20 个父帖，逐个调用的开销可以接受；如需优化，再合并为一条按序号的窗口查询。
 */
export async function locateParents(
  viewer: Subject,
  ids: readonly number[],
): Promise<Map<number, PostLocation | null>> {
  const unique = [...new Set(ids)];
  const out = new Map<number, PostLocation | null>();
  await Promise.all(
    unique.map(async (id) => {
      out.set(id, await locatePost(viewer, id));
    }),
  );
  return out;
}
