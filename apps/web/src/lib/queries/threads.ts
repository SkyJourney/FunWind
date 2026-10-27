import { cache } from "react";
import { and, count, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { contentReviews, forumPrefixes, getWebDb, posts, threads, users } from "@funwind/db";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import { getCurrentSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { clampPage } from "./paging";
import { buildViewerScope, visiblePredicate, type ViewerScope } from "./visibility";

/**
 * 主题查询：版块列表（置顶块 + 分页）、全站最新、详情。
 * 全部显式接收 viewer，经 visiblePredicate 在取数前过滤（见 visibility.ts）。
 */

export const THREADS_PER_PAGE = 25;

export type ThreadState = "visible" | "pending" | "rejected" | "hidden" | "deleted";

export interface ThreadListItem {
  id: number;
  forumId: number;
  title: string;
  authorId: number;
  authorName: string | null;
  /** 作者为“已注销用户”占位账号：界面显示“已注销”，不提供个人页链接 */
  authorDeleted: boolean;
  replyCount: number;
  viewCount: number;
  /** 0 无 / 1 版块 / 2 分区 / 3 全站 */
  pinLevel: number;
  isFeatured: boolean;
  isLocked: boolean;
  kind: "normal" | "poll";
  state: ThreadState;
  prefixName: string | null;
  lastPostedAt: string | null;
  createdAt: string;
}

const LIST_SELECTION = {
  id: threads.id,
  forumId: threads.forumId,
  title: threads.title,
  authorId: threads.authorId,
  authorName: users.username,
  authorState: users.state,
  replyCount: threads.replyCount,
  viewCount: threads.viewCount,
  pinLevel: threads.pinLevel,
  isFeatured: threads.isFeatured,
  isLocked: threads.isLocked,
  kind: threads.kind,
  state: threads.state,
  prefixName: forumPrefixes.name,
  lastPostedAt: threads.lastPostedAt,
  createdAt: threads.createdAt,
} as const;

type ListRow = Awaited<ReturnType<typeof selectList>>[number];

export function toItem(r: ListRow): ThreadListItem {
  const { authorState, ...rest } = r;
  return { ...rest, authorDeleted: authorState === "deleted" };
}

export const threadCols = {
  forumId: threads.forumId,
  state: threads.state,
  authorId: threads.authorId,
};
export const threadScope = (scope: ViewerScope) => visiblePredicate(threadCols, scope);

/** 以列表选择集查询（作者与前缀两个 left join） */
export function selectList(where: ReturnType<typeof threadScope>) {
  return getWebDb()
    .select(LIST_SELECTION)
    .from(threads)
    .leftJoin(users, eq(threads.authorId, users.id))
    .leftJoin(forumPrefixes, eq(threads.prefixId, forumPrefixes.id))
    .where(where);
}

export interface ThreadListPage {
  /** 置顶块：只在第 1 页、且未按前缀筛选时给出；不计入分页 */
  pinned: ThreadListItem[];
  items: ThreadListItem[];
  total: number;
  page: number;
  totalPages: number;
}

/**
 * 版块主题列表。置顶语义（docs/DESIGN-MODEL.md）：
 *   1 版块置顶 → 仅所属版块；2 分区置顶 → 所属分区子树内的所有版块；3 全站置顶 → 所有版块。
 * 跨版块置顶同样经 viewer 过滤——访客读不到的版块里的置顶帖不会出现。
 * 普通列表只含本版块 pin_level=0 的主题，置顶块里的帖子不会重复出现；按前缀筛选时不显示置顶块，
 * 此时本版块的置顶帖按 pin_level 优先排在筛选结果里。
 */
export async function listThreads(
  viewer: Subject,
  fid: number,
  opts: { page: number; prefixId?: number; tagId?: number },
): Promise<ThreadListPage> {
  const scope = await buildViewerScope(viewer);
  if (!scope.readable.includes(fid)) {
    return { pinned: [], items: [], total: 0, page: 1, totalPages: 1 };
  }
  const prefixed = opts.prefixId !== undefined && opts.prefixId > 0;
  const tagFilter =
    opts.tagId !== undefined && opts.tagId > 0
      ? sql`EXISTS (SELECT 1 FROM thread_tags tt WHERE tt.thread_id = ${threads.id} AND tt.tag_id = ${opts.tagId})`
      : undefined;
  const base = and(threadScope(scope), eq(threads.forumId, fid), tagFilter);
  const where = prefixed
    ? and(base, eq(threads.prefixId, opts.prefixId!))!
    : and(base, eq(threads.pinLevel, 0))!;

  const [nRow] = await getWebDb().select({ n: count() }).from(threads).where(where);
  const total = Number(nRow?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / THREADS_PER_PAGE));
  const page = clampPage(opts.page, totalPages);

  const rows = await selectList(where)
    .orderBy(
      ...(prefixed ? [desc(threads.pinLevel)] : []),
      desc(threads.lastPostedAt),
      desc(threads.id),
    )
    .limit(THREADS_PER_PAGE)
    .offset((page - 1) * THREADS_PER_PAGE);

  let pinned: ThreadListItem[] = [];
  if (page === 1 && !prefixed && !tagFilter) {
    const { tree } = await getAuthzSnapshot();
    const section = tree.chain(fid).find((id) => tree.get(id)?.kind === "section");
    const sectionIds = section !== undefined ? tree.subtree(section) : [fid];
    const pinnedRows = await selectList(
      and(
        threadScope(scope),
        gt(threads.pinLevel, 0),
        or(
          eq(threads.forumId, fid),
          eq(threads.pinLevel, 3),
          and(eq(threads.pinLevel, 2), inArray(threads.forumId, sectionIds)),
        ),
      )!,
    ).orderBy(desc(threads.pinLevel), desc(threads.lastPostedAt), desc(threads.id));
    pinned = pinnedRows.map((r) => toItem(r));
  }

  return { pinned, items: rows.map((r) => toItem(r)), total, page, totalPages };
}

/** 全站最新（版块页侧栏等）：只含读得到、且上目录（is_listed=1）的版块里的主题 */
export async function getLatestThreads(viewer: Subject, limit = 10): Promise<ThreadListItem[]> {
  const [scope, { tree }] = await Promise.all([buildViewerScope(viewer), getAuthzSnapshot()]);
  const listed = scope.readable.filter((id) => tree.get(id)?.isListed);
  if (listed.length === 0) return [];
  const rows = await selectList(
    and(threadScope(scope), inArray(threads.forumId, listed), eq(threads.state, "visible"))!,
  )
    .orderBy(desc(threads.lastPostedAt), desc(threads.id))
    .limit(limit);
  return rows.map((r) => toItem(r));
}

/* ===== 首页内容流（M10.5 S5，docs/wireframes/home-feed-list.html） ===== */

export const HOME_FEED_PAGE = 10;

export interface HomeFeedItem extends ThreadListItem {
  /** 首帖第一张图片（/files/ 或外链）；无图 null。D5 清洗后旧帖图片才可靠 */
  coverUrl: string | null;
  /** 首帖纯文本摘要（去 Markdown 结构），无正文 null */
  excerpt: string | null;
}

export interface HomeFeedPage {
  items: HomeFeedItem[];
  hasMore: boolean;
  page: number;
}

export type HomeFeedSort = "last" | "new";

export { extractFeedMedia } from "./feed-media";
import { extractFeedMedia } from "./feed-media";
import type { FeedMedia } from "./feed-media";

/**
 * 首页内容流：跨上目录版块混排，可按分区子树过滤、按最新回复/最新发布排序，偏移分页。
 * 权限口径与 getLatestThreads 一致：只含读得到、上目录、visible 的主题。
 */
export async function getHomeFeed(
  viewer: Subject,
  opts: { sectionId?: number; sort?: HomeFeedSort; page?: number } = {},
): Promise<HomeFeedPage> {
  const [scope, { tree }] = await Promise.all([buildViewerScope(viewer), getAuthzSnapshot()]);
  let listed = scope.readable.filter((id) => tree.get(id)?.isListed);
  if (opts.sectionId !== undefined) {
    const subtree = new Set(tree.subtree(opts.sectionId));
    listed = listed.filter((id) => subtree.has(id));
  }
  if (listed.length === 0) return { items: [], hasMore: false, page: 1 };

  const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
  const order =
    opts.sort === "new"
      ? [desc(threads.createdAt), desc(threads.id)]
      : [desc(threads.lastPostedAt), desc(threads.id)];
  const rows = await selectList(
    and(threadScope(scope), inArray(threads.forumId, listed), eq(threads.state, "visible"))!,
  )
    .orderBy(...order)
    .limit(HOME_FEED_PAGE + 1)
    .offset((page - 1) * HOME_FEED_PAGE);

  const hasMore = rows.length > HOME_FEED_PAGE;
  const items = rows.slice(0, HOME_FEED_PAGE).map((r) => toItem(r));

  const media = new Map<number, FeedMedia>();
  if (items.length > 0) {
    const bodies = await getWebDb()
      .select({ tid: threads.id, bodyMd: posts.bodyMd })
      .from(posts)
      .innerJoin(threads, eq(threads.firstPostId, posts.id))
      .where(
        and(
          inArray(
            threads.id,
            items.map((i) => i.id),
          ),
          eq(posts.floor, 1),
        ),
      );
    for (const b of bodies) media.set(b.tid, extractFeedMedia(b.bodyMd));
  }

  return {
    items: items.map((i) => ({ ...i, ...(media.get(i.id) ?? { coverUrl: null, excerpt: null }) })),
    hasMore,
    page,
  };
}

/** 站内热帖（右栏）：回复数优先，权限口径同内容流 */
export async function getHotThreads(viewer: Subject, limit = 5): Promise<ThreadListItem[]> {
  const [scope, { tree }] = await Promise.all([buildViewerScope(viewer), getAuthzSnapshot()]);
  const listed = scope.readable.filter((id) => tree.get(id)?.isListed);
  if (listed.length === 0) return [];
  const rows = await selectList(
    and(threadScope(scope), inArray(threads.forumId, listed), eq(threads.state, "visible"))!,
  )
    .orderBy(desc(threads.replyCount), desc(threads.id))
    .limit(limit);
  return rows.map((r) => toItem(r));
}

export interface FirstPost {
  id: number;
  bodyMd: string;
  hasGate: boolean;
  likeCount: number;
  createdAt: string;
  editedAt: string | null;
}

export interface ThreadView extends ThreadListItem {
  first: FirstPost;
  /** pending / rejected 时的最近一条审核记录（驳回理由） */
  review: { decision: "approved" | "rejected"; note: string } | null;
}

/** 主题详情（含首帖）；不存在或对该访客不可见返回 null（调用方一律 404） */
export async function getThreadView(viewer: Subject, tid: number): Promise<ThreadView | null> {
  const scope = await buildViewerScope(viewer);
  const rows = await selectList(and(threadScope(scope), eq(threads.id, tid))!).limit(1);
  const row = rows[0];
  if (!row) return null;
  const item = toItem(row);

  const db = getWebDb();
  const firstRows = await db
    .select({
      id: posts.id,
      bodyMd: posts.bodyMd,
      hasGate: posts.hasGate,
      likeCount: posts.likeCount,
      createdAt: posts.createdAt,
      editedAt: posts.editedAt,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.firstPostId, posts.id))
    .where(
      and(
        eq(threads.id, tid),
        eq(posts.floor, 1),
        // 首帖自己的状态也要过可见性：主题可见不代表首帖可见（主题状态与首帖状态可以分叉，
        // 见 docs/DESIGN-MODEL.md §4）。与 locateGate、/files 一致，正文不因只检查主题而泄露
        visiblePredicate(
          { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
          scope,
        ),
      ),
    );
  const first = firstRows[0];
  if (!first) return null;

  let review: ThreadView["review"] = null;
  if (item.state === "pending" || item.state === "rejected") {
    const r = await db
      .select({ decision: contentReviews.decision, note: contentReviews.note })
      .from(contentReviews)
      .where(eq(contentReviews.postId, first.id))
      .orderBy(desc(contentReviews.id))
      .limit(1);
    review = r[0] ?? null;
  }
  return { ...item, first: { ...first, bodyMd: first.bodyMd ?? "" }, review };
}

/**
 * 当前请求用户视角的主题详情，按 tid 请求级去重：页面与 generateMetadata 共用同一份结果，
 * 不可见的主题在两处都是 null（标题不会经 <title> 泄露）。
 */
export const getCurrentThreadView = cache(async (tid: number): Promise<ThreadView | null> => {
  return getThreadView(await getCurrentSubject(), tid);
});
