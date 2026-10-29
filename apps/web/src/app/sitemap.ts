import type { MetadataRoute } from "next";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getWebDb, threads } from "@funwind/db";
import { listForumRows } from "@/lib/forums/admin";
import { ForumTree } from "@/lib/forums/forum-tree";
import { getSiteIdentity } from "@/lib/site-chrome";

/**
 * sitemap（M10.6b）：首页/目录 + 公开可读且上目录的版块 + 这些版块下可见主题（前 2000 条）。
 * 受限/会员可见内容一律不进 sitemap（与游客可见口径一致，不泄露存在性）。
 * force-dynamic：内容随库实时变化，不能在构建期固化——构建环境（CI verify 作业）没有数据库。
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = (await getSiteIdentity()).url;
  const rows = await listForumRows();
  const tree = new ForumTree(rows);
  const publicForumIds = rows
    .filter((r) => r.kind === "forum" && r.isListed && tree.readPolicy(r.id).value === "public")
    .map((r) => r.id);

  const threadRows =
    publicForumIds.length > 0
      ? await getWebDb()
          .select({ id: threads.id, at: threads.lastPostedAt, created: threads.createdAt })
          .from(threads)
          .where(and(eq(threads.state, "visible"), inArray(threads.forumId, publicForumIds)))
          .orderBy(desc(threads.lastPostedAt))
          .limit(2000)
      : [];

  const entry = (path: string, lastModified?: string | Date) => ({
    url: `${siteUrl}${path}`,
    ...(lastModified ? { lastModified } : {}),
  });

  return [
    entry("/"),
    entry("/boards"),
    ...publicForumIds.map((id) => entry(`/f/${id}`)),
    ...threadRows.map((t) => entry(`/t/${t.id}`, t.at ?? t.created ?? undefined)),
  ];
}
