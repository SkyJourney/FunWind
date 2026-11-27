import "server-only";

import { getWebDb, posts, threads, users } from "@funwind/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbTx } from "@/lib/audit";
import { readableForumIds } from "@/lib/authz/evaluator";
import { loadFreshAuthzSnapshot } from "@/lib/authz/snapshot";
import { GUEST_SUBJECT } from "@/lib/authz/types";
import type { ForumNode } from "@/lib/forums/forum-tree";
import { publicUsername } from "@/lib/identity-expr";

export type FeedScope = { kind: "latest" } | { kind: "forum"; fid: number };

export interface FeedData {
  forumName: string | null;
  entries: {
    id: number;
    title: string;
    author: string;
    createdAt: string;
    editedAt: string | null;
    bodyMd: string;
  }[];
}

const FEED_LIMIT = 50;
// 首次普通 SELECT 建立一致性视图，后续授权与正文 SELECT 都复用它。
const FEED_READ_OPTIONS = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

/** 订阅资格同时要求游客可读和有效策略公开，受限版块获游客授权也不能订阅。 */
async function loadPublicFeedForums(tx: DbTx): Promise<Map<number, ForumNode>> {
  const snapshot = await loadFreshAuthzSnapshot(tx);
  const { tree } = snapshot;
  const eligible = new Map<number, ForumNode>();
  for (const fid of readableForumIds(GUEST_SUBJECT, snapshot)) {
    const forum = tree.get(fid);
    if (forum?.kind === "forum" && tree.readPolicy(fid).value === "public") {
      eligible.set(fid, forum);
    }
  }
  return eligible;
}

/** 页面发现和单版订阅共享版块资格，每次读取新鲜权限。 */
export function isPublicFeedForum(fid: number): Promise<boolean> {
  return getWebDb().transaction(async (tx) => {
    return (await loadPublicFeedForums(tx)).has(fid);
  }, FEED_READ_OPTIONS);
}

/** 在同一只读视图内查询权限和公开正文，时间保留数据库的北京时间格式。 */
export function loadFeed(scope: FeedScope): Promise<FeedData | null> {
  return getWebDb().transaction(async (tx) => {
    const eligible = await loadPublicFeedForums(tx);
    const forum = scope.kind === "forum" ? eligible.get(scope.fid) : null;
    if (scope.kind === "forum" && !forum) return null;

    const forumIds = forum
      ? [forum.id]
      : [...eligible.values()].filter((board) => board.isListed).map((board) => board.id);
    if (forumIds.length === 0) return { forumName: null, entries: [] };

    const rows = await tx
      .select({
        id: threads.id,
        title: threads.title,
        author: publicUsername(users.username, users.state, users.id),
        createdAt: threads.createdAt,
        editedAt: posts.editedAt,
        bodyMd: posts.bodyMd,
      })
      .from(threads)
      .innerJoin(
        posts,
        and(
          eq(posts.id, threads.firstPostId),
          eq(posts.threadId, threads.id),
          eq(posts.floor, 1),
          eq(posts.state, "visible"),
        ),
      )
      .leftJoin(users, eq(users.id, threads.authorId))
      .where(and(inArray(threads.forumId, forumIds), eq(threads.state, "visible")))
      .orderBy(desc(threads.createdAt), desc(threads.id))
      .limit(FEED_LIMIT);

    return {
      forumName: forum?.name ?? null,
      entries: rows.map((row) => ({
        ...row,
        author: row.author ?? "未知用户",
        bodyMd: row.bodyMd ?? "",
      })),
    };
  }, FEED_READ_OPTIONS);
}
