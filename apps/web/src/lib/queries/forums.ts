import { eq, inArray } from "drizzle-orm";
import { forumPrefixes, forums, getWebDb } from "@funwind/db";
import { getReadableForumIds } from "@/lib/authz/service";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import type { Subject } from "@/lib/authz/types";
import type { ForumNode } from "@/lib/forums/forum-tree";

/**
 * 版块查询：首页目录与版块页头部。所有函数显式接收 viewer——
 * 读不到的版块（受限版块、会员版块对游客）不会出现在任何结果里，包括计数。
 */

export interface DirectoryForum {
  id: number;
  name: string;
  description: string | null;
  threadCount: number;
  postCount: number;
  /** 直接子版块（同样只含读得到且上目录的） */
  subs: { id: number; name: string }[];
}

export interface DirectoryGroup {
  /** 分区；null = 不属于任何分区的顶层版块 */
  section: { id: number; name: string } | null;
  forums: DirectoryForum[];
}

export interface Directory {
  groups: DirectoryGroup[];
  /** 访客可见的版块数 / 主题数（首页统计；同样不得暴露受限版块的存在） */
  forumCount: number;
  threadCount: number;
}

async function loadCounts(ids: number[]): Promise<Map<number, { threads: number; posts: number }>> {
  if (ids.length === 0) return new Map();
  const rows = await getWebDb()
    .select({ id: forums.id, threads: forums.threadCount, posts: forums.postCount })
    .from(forums)
    .where(inArray(forums.id, ids));
  return new Map(rows.map((r) => [r.id, { threads: r.threads, posts: r.posts }]));
}

/** 首页目录：分区 → 版块（含子版块链接）。只含读得到且 is_listed=1 的版块；计数取 forums 缓存列 */
export async function getDirectory(viewer: Subject): Promise<Directory> {
  const [{ tree }, readable] = await Promise.all([getAuthzSnapshot(), getReadableForumIds(viewer)]);
  const ok = new Set(readable);
  const shown = (n: ForumNode) => ok.has(n.id) && n.isListed;
  const counts = await loadCounts(
    tree
      .all()
      .filter(shown)
      .map((n) => n.id),
  );

  const card = (n: ForumNode): DirectoryForum => ({
    id: n.id,
    name: n.name,
    description: n.description,
    threadCount: counts.get(n.id)?.threads ?? 0,
    postCount: counts.get(n.id)?.posts ?? 0,
    subs: tree
      .children(n.id)
      .filter((c) => c.kind === "forum" && shown(c))
      .map((c) => ({ id: c.id, name: c.name })),
  });

  const groups: DirectoryGroup[] = [];
  const loose: DirectoryForum[] = [];
  for (const root of tree.roots()) {
    if (root.kind === "section") {
      const cards = tree
        .children(root.id)
        .filter((c) => c.kind === "forum" && shown(c))
        .map(card);
      if (cards.length > 0) {
        groups.push({ section: { id: root.id, name: root.name }, forums: cards });
      }
    } else if (shown(root)) {
      loose.push(card(root));
    }
  }
  if (loose.length > 0) groups.push({ section: null, forums: loose });

  const listedForums = tree.all().filter((n) => n.kind === "forum" && shown(n));
  return {
    groups,
    forumCount: listedForums.length,
    threadCount: listedForums.reduce((sum, n) => sum + (counts.get(n.id)?.threads ?? 0), 0),
  };
}

export interface ForumView {
  id: number;
  kind: "section" | "forum";
  name: string;
  description: string | null;
  /** 面包屑：从根到父级（不含自身），只含读得到的祖先 */
  trail: { id: number; name: string; kind: "section" | "forum" }[];
  threadCount: number;
  postCount: number;
  prefixes: { id: number; name: string }[];
}

/** 版块页头部；不存在或读不到返回 null（调用方一律按 404，不暴露存在性） */
export async function getForumView(viewer: Subject, fid: number): Promise<ForumView | null> {
  const [{ tree }, readable] = await Promise.all([getAuthzSnapshot(), getReadableForumIds(viewer)]);
  const node = tree.get(fid);
  if (!node || !readable.includes(fid)) return null;
  const ok = new Set(readable);

  const [counts, prefixRows] = await Promise.all([
    loadCounts([fid]),
    getWebDb()
      .select({ id: forumPrefixes.id, name: forumPrefixes.name })
      .from(forumPrefixes)
      .where(eq(forumPrefixes.forumId, fid))
      .orderBy(forumPrefixes.sortOrder, forumPrefixes.id),
  ]);

  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    description: node.description,
    trail: tree
      .chain(fid)
      .slice(1)
      .reverse()
      .filter((id) => ok.has(id))
      .map((id) => ({ id, name: tree.get(id)!.name, kind: tree.get(id)!.kind })),
    threadCount: counts.get(fid)?.threads ?? 0,
    postCount: counts.get(fid)?.posts ?? 0,
    prefixes: prefixRows,
  };
}
