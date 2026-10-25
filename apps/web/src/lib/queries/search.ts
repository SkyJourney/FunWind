import { and, desc, eq, sql } from "drizzle-orm";
import { getWebDb, posts, threads } from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import { buildViewerScope, visiblePredicate } from "./visibility";
import { clampPage } from "./paging";
import type { ThreadListItem } from "./threads";

/**
 * 站内搜索（M8，docs/milestones/M8-interact-search.md §6）：MySQL FULLTEXT ngram 双列
 * （threads.title / posts.body_md——drizzle DSL 不支持 FULLTEXT，迁移 0006 手写 SQL）。
 *
 * 可见性硬约束：
 *  · 结果经 visiblePredicate（版块可读 + state 过滤）——body 命中路径额外限定 posts.state='visible'
 *    （作者本人的 pending/rejected 帖标题可命中，正文命中只看 visible）；
 *  · is_listed=0 版块不进聚合（ForumTree 过滤，与首页最新同口径）；
 *  · 索引只含 body_md（公开正文），门控隐藏内容只在 post_gates.hidden_md，天然不可搜。
 *
 * 排序：默认按相关度（MATCH score 降序）；?sort=time 切换最近回复。
 * 结果以**主题**为单位（帖子命中折叠到主题，标题命中直接返回）。
 */

export const SEARCH_PER_PAGE = 20;

export interface SearchHit extends ThreadListItem {
  /** 命中来源：title=标题命中；body=正文命中 */
  via: "title" | "body";
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  page: number;
  totalPages: number;
  /** 查询是否被清洗为空（前端显示引导而非零结果） */
  emptyQuery: boolean;
}

/** 查询清洗：去空白；ngram 对 1 字符也能建 2-gram 邻组（中文单字可命中 2-gram 词），但空串必须拦 */
export function cleanQuery(raw: string): string {
  return raw.trim().slice(0, 64);
}

const THREAD_COLS = { forumId: threads.forumId, state: threads.state, authorId: threads.authorId };

export async function searchThreads(
  viewer: Subject,
  q: string,
  opts: { page?: number; sort?: "relevance" | "time"; forumId?: number } = {},
): Promise<SearchResult> {
  const query = cleanQuery(q);
  const empty: SearchResult = {
    hits: [],
    total: 0,
    page: 1,
    totalPages: 1,
    emptyQuery: query.length === 0,
  };
  if (query.length === 0) return empty;

  const [scope, { tree }] = await Promise.all([buildViewerScope(viewer), getAuthzSnapshot()]);
  const listed = scope.readable.filter((id) => tree.get(id)?.isListed);
  if (listed.length === 0) return empty;

  const inListed = sql`${threads.forumId} IN (${sql.join(
    listed.map((id) => sql`${id}`),
    sql`, `,
  )})`;
  const forumFilter = opts.forumId ? eq(threads.forumId, opts.forumId) : undefined;
  const visible = visiblePredicate(THREAD_COLS, scope);

  // 标题命中（主题级）
  const titleMatch = sql`MATCH(${threads.title}) AGAINST(${query} IN BOOLEAN MODE)`;
  // 正文命中（折叠到主题；正文帖必须 visible——作者自己的待审正文也不搜出来，避免误暴露草稿状态）
  const bodyMatch = sql`EXISTS (
    SELECT 1 FROM ${posts}
    WHERE ${posts.threadId} = ${threads.id}
      AND ${posts.state} = 'visible'
      AND MATCH(${posts.bodyMd}) AGAINST(${query} IN BOOLEAN MODE)
  )`;

  const where = and(visible, inListed, forumFilter, sql`(${titleMatch} OR ${bodyMatch})`)!;

  const [{ n }] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(threads)
    .where(where);
  const total = Number(n);
  const totalPages = Math.max(1, Math.ceil(total / SEARCH_PER_PAGE));
  const page = clampPage(opts.page ?? 1, totalPages);
  if (total === 0) return { ...empty, emptyQuery: false };

  const orderBy =
    opts.sort === "time"
      ? [desc(threads.lastPostedAt), desc(threads.id)]
      : [desc(sql`(${titleMatch})`), desc(threads.lastPostedAt), desc(threads.id)];

  const rows = await getWebDb()
    .select({
      id: threads.id,
      forumId: threads.forumId,
      title: threads.title,
      authorId: threads.authorId,
      replyCount: threads.replyCount,
      viewCount: threads.viewCount,
      pinLevel: threads.pinLevel,
      isFeatured: threads.isFeatured,
      isLocked: threads.isLocked,
      kind: threads.kind,
      state: threads.state,
      lastPostedAt: threads.lastPostedAt,
      createdAt: threads.createdAt,
      viaTitle: sql<boolean>`(${titleMatch})`,
    })
    .from(threads)
    .where(where)
    .orderBy(...orderBy)
    .limit(SEARCH_PER_PAGE)
    .offset((page - 1) * SEARCH_PER_PAGE);

  const hits: SearchHit[] = rows.map((r) => ({
    id: r.id,
    forumId: r.forumId,
    title: r.title,
    authorId: r.authorId,
    authorName: null, // 列表行展示由 ThreadRow 的 forumName 承担主要上下文；作者名在主题页
    authorDeleted: false,
    replyCount: r.replyCount,
    viewCount: r.viewCount,
    pinLevel: r.pinLevel,
    isFeatured: r.isFeatured,
    isLocked: r.isLocked,
    kind: r.kind,
    state: r.state as ThreadListItem["state"],
    prefixName: null,
    lastPostedAt: r.lastPostedAt,
    createdAt: r.createdAt,
    via: r.viaTitle ? "title" : "body",
  }));
  return { hits, total, page, totalPages, emptyQuery: false };
}
